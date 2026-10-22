import { randomBytes } from "node:crypto";
import { httpTransport } from "./http.js";
import { classify, defaultRetryPolicy, parseRetryAfter, retryDelay, type Outcome, type RetryPolicy } from "./retry.js";
import { signWebhook } from "./signature.js";
import type { EndpointStore } from "./endpoints.js";
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
  /** A fixed list, or an {@link EndpointStore} that is read on every publish and tick. */
  endpoints: Endpoint[] | EndpointStore;
  /** Sends the requests. Defaults to {@link httpTransport}, which refuses private addresses. */
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
  /** Deliveries pushed back because the endpoint's breaker was open or the endpoint is paused. */
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
  private endpoints: Endpoint[] | EndpointStore = [];
  readonly store: DeliveryStore;
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
  /** Endpoints this dispatcher is sending to right now, so overlapping ticks leave them alone. */
  private readonly draining = new Set<string>();
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(options: DispatcherOptions) {
    this.store = options.store;
    this.setEndpoints(options.endpoints);
    this.transport = options.transport ?? httpTransport();
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

  /** Replaces the endpoints. Deliveries to removed endpoints are dead-lettered when they come due. */
  setEndpoints(endpoints: Endpoint[] | EndpointStore): void {
    this.endpoints = endpoints;
  }

  /** The current endpoints, read from the store if there is one. */
  async listEndpoints(): Promise<Endpoint[]> {
    return Array.isArray(this.endpoints) ? [...this.endpoints] : this.endpoints.list();
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
    for (const endpoint of await this.listEndpoints()) {
      if (event.endpointIds) {
        if (!event.endpointIds.includes(endpoint.id)) continue;
      } else if (endpoint.eventTypes && !endpoint.eventTypes.includes(event.type)) continue;
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
   * different endpoints run in parallel. Ticks may overlap: an endpoint that
   * a previous tick is still sending to (a slow one) is skipped, so it does
   * not hold up the others. Pass `now` to drive a simulated clock; without it
   * the real clock is read at each step.
   */
  async tick(now?: number, limit = 100): Promise<TickReport> {
    const clock = () => now ?? Date.now();
    const report: TickReport = { attempted: 0, delivered: 0, retried: 0, dead: 0, postponed: 0, conflicts: 0 };
    // Rows of endpoints that an earlier tick is still sending to are skipped; ask for more so others are not starved.
    const due = await this.store.due(clock(), this.draining.size ? limit * 2 : limit);
    const byEndpoint = new Map<string, Delivery[]>();
    let taken = 0;
    for (const d of due) {
      if (this.draining.has(d.endpointId) || taken >= limit) continue;
      taken++;
      byEndpoint.set(d.endpointId, [...(byEndpoint.get(d.endpointId) ?? []), d]);
    }
    const endpoints = due.length ? new Map((await this.listEndpoints()).map((e) => [e.id, e])) : new Map<string, Endpoint>();
    await Promise.all(
      [...byEndpoint].map(async ([endpointId, list]) => {
        this.draining.add(endpointId);
        try {
          await this.drainEndpoint(endpoints.get(endpointId), endpointId, list, clock, report);
        } finally {
          this.draining.delete(endpointId);
        }
      }),
    );
    return report;
  }

  /**
   * Calls `tick()` every `intervalMs`. A slow endpoint keeps its own tick
   * busy without delaying the others. Returns a function that stops it.
   */
  start(intervalMs = 1_000): () => void {
    const timer = setInterval(() => void this.tick().catch(() => undefined), intervalMs);
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

  private async drainEndpoint(
    endpoint: Endpoint | undefined,
    endpointId: string,
    list: Delivery[],
    clock: () => number,
    report: TickReport,
  ): Promise<void> {
    const before = (await this.store.getEndpointState(endpointId)) ?? emptyState(endpointId);
    const state = { ...before };

    const deliverOne = async (delivery: Delivery): Promise<void> => {
      const now = clock();
      if (!endpoint || state.disabled) {
        await this.finish(delivery, delivery.version, { status: "dead", deadAt: now, deadReason: "endpoint-unavailable" }, report);
        return;
      }
      if (now - delivery.cycleStartedAt > this.retry.maxAgeMs) {
        await this.finish(delivery, delivery.version, { status: "dead", deadAt: now, deadReason: "expired" }, report);
        return;
      }
      const wait = state.openUntil > now || endpoint.paused ? 0 : this.rateWait(endpoint, now);
      if (state.openUntil > now || endpoint.paused || wait > 0) {
        const until = endpoint.paused ? now + PAUSE_RECHECK_MS : wait > 0 ? now + wait : state.openUntil;
        const ok = await this.store.update({ ...delivery, status: "pending", nextAttemptAt: until }, delivery.version);
        if (ok) report.postponed++;
        else report.conflicts++;
        return;
      }

      // Take the lease. If the worker dies after this, the delivery comes due again when the lease expires.
      const claimed: Delivery = { ...delivery, status: "sending", nextAttemptAt: now + this.leaseMs };
      if (!(await this.store.update(claimed, delivery.version))) {
        report.conflicts++;
        return;
      }
      const version = delivery.version + 1;

      const { attempt, retryAfterMs } = await this.send(endpoint, delivery, now);
      // Sending again will not change the address, so a blocked request is a rejection.
      const outcome = attempt.error === BLOCKED ? "reject" : classify(attempt.status);
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
        if (attempt.status) Object.assign(state, { failures: 0, opened: 0, openUntil: 0 });
        if (outcome === "gone") state.disabled = true;
        result = dead(base, done, outcome === "gone" ? "gone" : "rejected");
      }

      await this.finish(delivery, version, result, report);
      if (result.status === "pending") report.retried++;
      this.emitAttempt({ delivery: { ...result, version: version + 1 }, attempt, outcome, breakerOpenedUntil });
    };

    // Up to maxConcurrency requests to this endpoint at a time; the breaker state is shared between them.
    const queue = [...list];
    const wanted = Math.floor(endpoint?.maxConcurrency ?? 1);
    const lanes = Number.isFinite(wanted) ? Math.max(1, Math.min(MAX_CONCURRENCY, wanted)) : 1;
    await Promise.all(
      Array.from({ length: lanes }, async () => {
        for (let d = queue.shift(); d; d = queue.shift()) await deliverOne(d);
      }),
    );

    if (JSON.stringify(state) !== JSON.stringify(before)) await this.store.saveEndpointState(state);
  }

  /**
   * Token bucket per endpoint for `rateLimit` (requests per second). Returns 0
   * and takes a token if one is available, otherwise how long until one is.
   * Kept in memory, so the limit applies per dispatcher.
   */
  private rateWait(endpoint: Endpoint, now: number): number {
    const rate = endpoint.rateLimit;
    if (!rate || rate <= 0) return 0;
    const capacity = Math.max(1, rate);
    const bucket = this.buckets.get(endpoint.id) ?? { tokens: capacity, at: now };
    bucket.tokens = Math.min(capacity, bucket.tokens + (Math.max(0, now - bucket.at) * rate) / 1000);
    bucket.at = now;
    this.buckets.set(endpoint.id, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - bucket.tokens) * 1000) / rate);
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

/** Attempt error for a request the transport refused to send to a private address. */
const BLOCKED = "blocked-address";

/** Upper bound for `Endpoint.maxConcurrency`. */
const MAX_CONCURRENCY = 50;

/** How often deliveries to a paused endpoint are looked at again. */
const PAUSE_RECHECK_MS = 10_000;

function dead(delivery: Delivery, at: number, reason: DeadReason): Delivery {
  return { ...delivery, status: "dead", deadAt: at, deadReason: reason };
}

function emptyState(endpointId: string): EndpointState {
  return { endpointId, failures: 0, openUntil: 0, opened: 0, disabled: false };
}

function describe(err: unknown): string {
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "timeout";
  const code = e?.cause?.code ?? e?.code;
  if (code === "ERR_BLOCKED_ADDRESS") return BLOCKED;
  // fetch reports a connection closed by the server as an undici socket error.
  if (code === "UND_ERR_SOCKET") return "ECONNRESET";
  return code ?? e?.name ?? "network";
}

function safely(f: () => void): void {
  try {
    f();
  } catch {
    // Listeners must not break delivery.
  }
}
