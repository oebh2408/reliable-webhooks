import { randomBytes } from "node:crypto";
import { fetchTransport } from "./http.js";
import { classify, defaultRetryPolicy, parseRetryAfter, retryDelay, type Outcome, type RetryPolicy } from "./retry.js";
import { signWebhook } from "./signature.js";
import type { DeliveryQuery, DeliveryStore } from "./store.js";
import type { Attempt, DeadReason, Delivery, Endpoint, EndpointState, Transport, WebhookEvent } from "./types.js";

export interface BreakerOptions {
  /** Consecutive failed attempts (5xx, 429, timeouts) that open the breaker. Default 5. */
  failureThreshold: number;
  /** How long the first opening lasts. Doubles on each consecutive opening. Default 30 s. */
  cooldownMs: number;
  /** Upper bound for the cooldown. Default 30 min. */
  maxCooldownMs: number;
}

export const defaultBreaker: BreakerOptions = { failureThreshold: 5, cooldownMs: 30_000, maxCooldownMs: 30 * 60_000 };

export interface DispatcherOptions {
  store: DeliveryStore;
  endpoints: Endpoint[];
  /** Sends the requests. Defaults to {@link fetchTransport}. */
  transport?: Transport;
  retry?: Partial<RetryPolicy>;
  /** Per-endpoint circuit breaker; `false` turns it off. */
  breaker?: Partial<BreakerOptions> | false;
  /** Request timeout. Default 15 s. */
  timeoutMs?: number;
  /**
   * How long a worker owns a delivery while sending it. If the worker dies,
   * another one takes the delivery over after this. Must be longer than the
   * timeout. Default 60 s.
   */
  leaseMs?: number;
  /** Attempts kept on each delivery. Default 10. */
  historyLimit?: number;
  /** Source of randomness for jitter. Inject a seeded one for reproducible runs. */
  random?: () => number;
  /** Generates message ids. Default `msg_` plus 24 hex characters. */
  newId?: () => string;
  userAgent?: string;
}

export interface AttemptEvent {
  delivery: Delivery;
  attempt: Attempt;
  outcome: Outcome;
  /** Set when this attempt opened the endpoint's circuit breaker. */
  breakerOpenedUntil?: number;
}

export interface TickReport {
  attempted: number;
  delivered: number;
  retried: number;
  dead: number;
  /** Deliveries pushed back because the endpoint's breaker was open. */
  postponed: number;
  /** Deliveries another worker changed first. */
  conflicts: number;
}

export interface PublishResult {
  messageId: string;
  /** Ids of the deliveries created, one per subscribed endpoint. Empty if they already existed. */
  deliveries: string[];
}

/**
 * Sends webhooks from a {@link DeliveryStore} with retries, backoff, a circuit
 * breaker per endpoint and dead letters.
 *
 * `publish()` only writes to the store. Requests are sent by `tick()`, which
 * a timer (`start()`), a cron job or a scheduled function calls. Several
 * dispatchers may share one store. Delivery is at least once, see ADR 0003.
 */
export class WebhookDispatcher {
  private endpoints = new Map<string, Endpoint>();
  private readonly store: DeliveryStore;
  private readonly transport: Transport;
  private readonly retry: RetryPolicy;
  private readonly breaker: BreakerOptions | undefined;
  private readonly timeoutMs: number;
  private readonly leaseMs: number;
  private readonly historyLimit: number;
  private readonly random: () => number;
  private readonly newId: () => string;
  private readonly userAgent: string;
  private readonly attemptListeners: ((e: AttemptEvent) => void)[] = [];
  private readonly deadListeners: ((d: Delivery) => void)[] = [];

  constructor(options: DispatcherOptions) {
    this.store = options.store;
    this.setEndpoints(options.endpoints);
    this.transport = options.transport ?? fetchTransport();
    this.retry = { ...defaultRetryPolicy, ...options.retry };
    this.breaker = options.breaker === false ? undefined : { ...defaultBreaker, ...options.breaker };
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.historyLimit = options.historyLimit ?? 10;
    this.random = options.random ?? Math.random;
    this.newId = options.newId ?? (() => `msg_${randomBytes(12).toString("hex")}`);
    this.userAgent = options.userAgent ?? "reliable-webhooks";
    if (this.leaseMs <= this.timeoutMs) throw new Error("leaseMs must be longer than timeoutMs");
  }

  /** Replaces the endpoint list. Deliveries to removed endpoints are dead-lettered when they come due. */
  setEndpoints(endpoints: Endpoint[]): void {
    this.endpoints = new Map(endpoints.map((e) => [e.id, e]));
  }

  /** Called after every attempt. Listener errors are ignored. */
  onAttempt(listener: (event: AttemptEvent) => void): void {
    this.attemptListeners.push(listener);
  }

  /** Called when a delivery is dead-lettered, for alerting. Listener errors are ignored. */
  onDead(listener: (delivery: Delivery) => void): void {
    this.deadListeners.push(listener);
  }

  /**
   * Stores one delivery per subscribed endpoint. Nothing is sent yet.
   * Publishing again with the same `event.id` does not create duplicates.
   */
  async publish(event: WebhookEvent, now = Date.now()): Promise<PublishResult> {
    const messageId = event.id ?? this.newId();
    const deliveries = await this.prepare({ ...event, id: messageId }, now);
    const inserted = await this.store.insert(deliveries);
    return { messageId, deliveries: inserted ? deliveries.map((d) => d.id) : [] };
  }

  /**
   * Builds the deliveries for an event without storing them. Use it to write
   * them in the same database transaction as the change that caused the
   * event (the transactional outbox), see examples/outbox.ts.
   */
  async prepare(event: WebhookEvent, now = Date.now()): Promise<Delivery[]> {
    const messageId = event.id ?? this.newId();
    const body = JSON.stringify({ type: event.type, timestamp: new Date(now).toISOString(), data: event.payload });
    const deliveries: Delivery[] = [];
    for (const endpoint of this.endpoints.values()) {
      if (endpoint.eventTypes && !endpoint.eventTypes.includes(event.type)) continue;
      if ((await this.store.getEndpointState(endpoint.id))?.disabled) continue;
      deliveries.push({
        id: `${messageId}:${endpoint.id}`,
        messageId,
        endpointId: endpoint.id,
        eventType: event.type,
        body,
        createdAt: now,
        cycleStartedAt: now,
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
        history: [],
        version: 0,
      });
    }
    return deliveries;
  }

  /**
   * Sends what is due. Deliveries to the same endpoint go one after another;
   * different endpoints run in parallel. Pass `now` to drive a simulated
   * clock; without it the real clock is read at each step.
   */
  async tick(now?: number, limit = 100): Promise<TickReport> {
    const clock = () => now ?? Date.now();
    const report: TickReport = { attempted: 0, delivered: 0, retried: 0, dead: 0, postponed: 0, conflicts: 0 };
    const due = await this.store.due(clock(), limit);
    const byEndpoint = new Map<string, Delivery[]>();
    for (const d of due) byEndpoint.set(d.endpointId, [...(byEndpoint.get(d.endpointId) ?? []), d]);
    await Promise.all([...byEndpoint].map(([endpointId, list]) => this.drainEndpoint(endpointId, list, clock, report)));
    return report;
  }

  /** Calls `tick()` every `intervalMs` without overlapping runs. Returns a function that stops it. */
  start(intervalMs = 1_000): () => void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      this.tick()
        .catch(() => undefined)
        .finally(() => (running = false));
    }, intervalMs);
    return () => clearInterval(timer);
  }

  /** Dead-lettered deliveries, oldest first. */
  deadLetters(query: Omit<DeliveryQuery, "status"> = {}): Promise<Delivery[]> {
    return this.store.list({ ...query, status: "dead" });
  }

  /**
   * Puts dead deliveries back in the queue with a fresh retry cycle. With no
   * query, all of them. Returns how many were requeued. A disabled endpoint
   * has to be enabled first, see {@link enableEndpoint}.
   */
  async redeliver(query: Omit<DeliveryQuery, "status"> & { ids?: string[] } = {}, now = Date.now()): Promise<number> {
    const dead = query.ids
      ? (await Promise.all(query.ids.map((id) => this.store.get(id)))).filter((d): d is Delivery => d?.status === "dead")
      : await this.deadLetters(query);
    let requeued = 0;
    for (const d of dead) {
      const next: Delivery = {
        ...d,
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
        cycleStartedAt: now,
        deadAt: undefined,
        deadReason: undefined,
      };
      if (await this.store.update(next, d.version)) requeued++;
    }
    return requeued;
  }

  /** Re-enables an endpoint disabled by a 410 and closes its breaker. */
  async enableEndpoint(endpointId: string): Promise<void> {
    await this.store.saveEndpointState({ ...emptyState(endpointId), disabled: false });
  }

  private async drainEndpoint(endpointId: string, list: Delivery[], clock: () => number, report: TickReport): Promise<void> {
    const endpoint = this.endpoints.get(endpointId);
    const before = (await this.store.getEndpointState(endpointId)) ?? emptyState(endpointId);
    const state = { ...before };

    for (const delivery of list) {
      const now = clock();
      if (!endpoint || state.disabled) {
        await this.finish(delivery, delivery.version, { status: "dead", deadAt: now, deadReason: "endpoint-unavailable" }, report);
        continue;
      }
      if (now - delivery.cycleStartedAt > this.retry.maxAgeMs) {
        await this.finish(delivery, delivery.version, { status: "dead", deadAt: now, deadReason: "expired" }, report);
        continue;
      }
      if (state.openUntil > now) {
        const ok = await this.store.update({ ...delivery, status: "pending", nextAttemptAt: state.openUntil }, delivery.version);
        if (ok) report.postponed++;
        else report.conflicts++;
        continue;
      }

      // Take the lease. If the worker dies after this, the delivery comes due again when the lease expires.
      const claimed: Delivery = { ...delivery, status: "sending", nextAttemptAt: now + this.leaseMs };
      if (!(await this.store.update(claimed, delivery.version))) {
        report.conflicts++;
        continue;
      }
      const version = delivery.version + 1;

      const { attempt, retryAfterMs } = await this.send(endpoint, delivery, now);
      const outcome = classify(attempt.status);
      const done = clock();
      const history = [...delivery.history, attempt].slice(-this.historyLimit);
      const attempts = delivery.attempts + 1;
      const base = { ...claimed, attempts, history };
      report.attempted++;

      let breakerOpenedUntil: number | undefined;
      let result: Delivery;
      if (outcome === "success") {
        Object.assign(state, { failures: 0, opened: 0, openUntil: 0 });
        result = { ...base, status: "delivered", deliveredAt: done };
      } else if (outcome === "retry") {
        state.failures++;
        // A failure right after a cooldown (the breaker has opened and no success has closed it) reopens it at once.
        if (this.breaker && (state.failures >= this.breaker.failureThreshold || state.opened > 0)) {
          state.opened++;
          state.failures = 0;
          state.openUntil = done + Math.min(this.breaker.maxCooldownMs, this.breaker.cooldownMs * 2 ** (state.opened - 1));
          breakerOpenedUntil = state.openUntil;
        }
        const next = done + retryDelay(this.retry, attempts, this.random, retryAfterMs);
        result =
          attempts >= this.retry.maxAttempts
            ? dead(base, done, "exhausted")
            : next - delivery.cycleStartedAt > this.retry.maxAgeMs
              ? dead(base, done, "expired")
              : { ...base, status: "pending", nextAttemptAt: next };
      } else {
        // The endpoint answered, so it is up; only the request was refused.
        Object.assign(state, { failures: 0, opened: 0, openUntil: 0 });
        if (outcome === "gone") state.disabled = true;
        result = dead(base, done, outcome === "gone" ? "gone" : "rejected");
      }

      await this.finish(delivery, version, result, report);
      if (result.status === "pending") report.retried++;
      this.emitAttempt({ delivery: { ...result, version: version + 1 }, attempt, outcome, breakerOpenedUntil });
    }

    if (JSON.stringify(state) !== JSON.stringify(before)) await this.store.saveEndpointState(state);
  }

  private async send(endpoint: Endpoint, delivery: Delivery, now: number): Promise<{ attempt: Attempt; retryAfterMs?: number }> {
    const headers = {
      "content-type": "application/json",
      "user-agent": this.userAgent,
      ...endpoint.headers,
      ...signWebhook({ id: delivery.messageId, timestamp: Math.floor(now / 1000), body: delivery.body, secrets: endpoint.secrets }),
    };
    const started = Date.now();
    try {
      const res = await this.transport({
        url: endpoint.url,
        headers,
        body: delivery.body,
        timeoutMs: endpoint.timeoutMs ?? this.timeoutMs,
        now,
      });
      return {
        attempt: { at: now, status: res.status, durationMs: res.durationMs ?? Date.now() - started },
        retryAfterMs: parseRetryAfter(res.headers?.["retry-after"], now),
      };
    } catch (err) {
      return { attempt: { at: now, status: 0, error: describe(err), durationMs: Date.now() - started } };
    }
  }

  private async finish(
    delivery: Delivery,
    expectedVersion: number,
    change: Partial<Delivery>,
    report: TickReport,
  ): Promise<void> {
    const next = { ...delivery, ...change };
    if (!(await this.store.update(next, expectedVersion))) {
      report.conflicts++;
      return;
    }
    if (next.status === "delivered") report.delivered++;
    if (next.status === "dead") {
      report.dead++;
      for (const l of this.deadListeners) safely(() => l({ ...next, version: expectedVersion + 1 }));
    }
  }

  private emitAttempt(event: AttemptEvent): void {
    for (const l of this.attemptListeners) safely(() => l(event));
  }
}

function dead(delivery: Delivery, at: number, reason: DeadReason): Delivery {
  return { ...delivery, status: "dead", deadAt: at, deadReason: reason };
}

function emptyState(endpointId: string): EndpointState {
  return { endpointId, failures: 0, openUntil: 0, opened: 0, disabled: false };
}

function describe(err: unknown): string {
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timeout";
  return e?.cause?.code ?? e?.code ?? e?.name ?? "network";
}

function safely(f: () => void): void {
  try {
    f();
  } catch {
    // Listeners must not break delivery.
  }
}
