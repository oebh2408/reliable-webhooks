import { WebhookDispatcher, type AttemptEvent, type DispatcherOptions } from "./dispatcher.js";
import { WebhookReceiver, type IdempotencyStore } from "./receiver.js";
import { MemoryDeliveryStore, type DeliveryStore } from "./store.js";
import type { DeadReason, Endpoint, OutgoingRequest, TransportResponse } from "./types.js";

/** Small seeded generator (mulberry32), so every run with the same seed is identical. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimulatedEndpoint {
  endpoint: Endpoint;
  /** One line describing how it misbehaves. */
  behaviour: string;
  receiver: WebhookReceiver;
  /** Message ids processed by the handler, with how many times each. */
  processed: Map<string, number>;
  /** Requests the receiver recognised as already processed. */
  duplicates: number;
  respond(req: OutgoingRequest, rng: () => number): Promise<TransportResponse>;
}

export interface ScenarioOptions {
  /** Messages published. Default 120. */
  messages?: number;
  /** Messages are spread over this window. Default 5 minutes. */
  publishWindowMs?: number;
  seed?: number;
  /** Dispatchers sharing the store, as several workers or function instances would. Default 1. */
  workers?: number;
  /** How often the dispatchers tick, in simulated time. Default 1 s. */
  tickMs?: number;
  /** Where deliveries are kept. Default a new {@link MemoryDeliveryStore}. */
  store?: DeliveryStore;
  /** Creates each receiver's idempotency store. Default in memory. */
  idempotencyStore?: (endpointId: string) => IdempotencyStore;
  /** Passed to the dispatchers; `false` turns the circuit breaker off. */
  breaker?: DispatcherOptions["breaker"];
  /** Skip the second phase that fixes the misconfigured receiver and redelivers its dead letters. */
  noRedelivery?: boolean;
}

export interface AttemptLogEntry {
  at: number;
  messageId: string;
  endpointId: string;
  status: number;
  error?: string;
  result: "delivered" | "retry" | "dead";
  nextAttemptAt?: number;
  deadReason?: DeadReason;
  breakerOpenedUntil?: number;
}

export interface EndpointSummary {
  id: string;
  behaviour: string;
  expected: number;
  processedOnce: number;
  attempts: number;
  retries: number;
  duplicatesAbsorbed: number;
  breakerOpenings: number;
  deadLettered: number;
}

export interface ScenarioResult {
  startedAt: number;
  finishedAt: number;
  messages: number;
  deliveries: number;
  attempts: number;
  retries: number;
  /** Requests a receiver had already processed (the response was lost), dropped by its idempotency check. */
  duplicatesAbsorbed: number;
  breakerOpenings: number;
  /** Dead letters at the end of the first phase. */
  deadLettered: number;
  redelivered: number;
  /** Dead letters left at the very end. */
  deadRemaining: number;
  /** Every expected (message, endpoint) pair was handled exactly once, and nothing else was. */
  exactlyOnce: boolean;
  endpoints: EndpointSummary[];
  log: AttemptLogEntry[];
}

const TYPES = ["order.created", "order.paid", "order.shipped", "invoice.issued"];
const MIN = 60_000;

function endpoints(start: number, idempotency?: (endpointId: string) => IdempotencyStore): SimulatedEndpoint[] {
  const make = (
    id: string,
    behaviour: string,
    eventTypes: string[] | undefined,
    respond: (self: SimulatedEndpoint, req: OutgoingRequest, rng: () => number) => Promise<TransportResponse>,
    receiverSecret = `whsec_${Buffer.from(`${id}-secret-0123456789`).toString("base64")}`,
  ): SimulatedEndpoint => {
    const secret = `whsec_${Buffer.from(`${id}-secret-0123456789`).toString("base64")}`;
    const self: SimulatedEndpoint = {
      endpoint: { id, url: `https://${id}.example.test/webhooks`, secrets: [secret], eventTypes },
      behaviour,
      receiver: new WebhookReceiver({ secrets: [receiverSecret], store: idempotency?.(id) }),
      processed: new Map(),
      duplicates: 0,
      respond: (req, rng) => respond(self, req, rng),
    };
    return self;
  };

  const handle = async (self: SimulatedEndpoint, req: OutgoingRequest): Promise<TransportResponse> => {
    const result = await self.receiver.handle(req, (e) => {
      self.processed.set(e.id, (self.processed.get(e.id) ?? 0) + 1);
    }, req.now);
    if (result.outcome === "duplicate") self.duplicates++;
    return { status: result.status, headers: result.headers };
  };
  const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

  const rateWindow: number[] = [];

  return [
    make("orders", "healthy, 5% of responses lost", undefined, async (self, req, rng) => {
      const res = await handle(self, req);
      // Processed, but the response never reaches the sender, which will retry.
      if (rng() < 0.05) throw timeout();
      return res;
    }),
    make("crm", "25% of requests fail with 503", ["order.created", "order.paid"], async (self, req, rng) =>
      rng() < 0.25 ? { status: 503 } : handle(self, req),
    ),
    make("analytics", "down for 20 minutes", undefined, async (self, req) => {
      if (req.now >= start + 2 * MIN && req.now < start + 22 * MIN) throw refused();
      return handle(self, req);
    }),
    make("partner", "rate limited, 4 requests per 10 s", ["order.paid", "order.shipped"], async (self, req) => {
      while (rateWindow.length && rateWindow[0]! <= req.now - 10_000) rateWindow.shift();
      if (rateWindow.length >= 4) return { status: 429, headers: { "retry-after": "10" } };
      rateWindow.push(req.now);
      return handle(self, req);
    }),
    make(
      "legacy",
      "receiver has the wrong secret",
      ["invoice.issued", "order.paid"],
      async (self, req) => handle(self, req),
      "whsec_c3RhbGUtc2VjcmV0LWZyb20tbGFzdC15ZWFy",
    ),
  ];
}

/**
 * Publishes messages to five simulated endpoints, each with a real
 * {@link WebhookReceiver}, and drives the dispatcher on a simulated clock
 * until every delivery is delivered or dead. Then fixes the misconfigured
 * receiver, redelivers its dead letters and runs again.
 *
 * Returns what happened, plus a check against the ground truth: each message
 * must have been handled exactly once by each subscribed endpoint.
 */
export async function runScenario(options: ScenarioOptions = {}): Promise<ScenarioResult> {
  const { messages = 120, publishWindowMs = 5 * MIN, seed = 7, workers = 1, tickMs = 1_000 } = options;
  const rng = seededRandom(seed);
  const start = Date.UTC(2026, 0, 12, 9, 0, 0);
  const sims = endpoints(start, options.idempotencyStore);
  const byUrl = new Map(sims.map((s) => [s.endpoint.url, s]));
  const store = options.store ?? new MemoryDeliveryStore();
  const log: AttemptLogEntry[] = [];
  const transport = (req: OutgoingRequest) => byUrl.get(req.url)!.respond(req, rng);

  let counter = 0;
  const dispatchers = Array.from({ length: workers }, (_, w) => {
    const d = new WebhookDispatcher({
      store,
      endpoints: sims.map((s) => s.endpoint),
      transport,
      breaker: options.breaker,
      random: seededRandom(seed * 31 + w),
      newId: () => `msg_${String(++counter).padStart(4, "0")}`,
    });
    d.onAttempt((e: AttemptEvent) =>
      log.push({
        at: e.attempt.at,
        messageId: e.delivery.messageId,
        endpointId: e.delivery.endpointId,
        status: e.attempt.status,
        error: e.attempt.error,
        result: e.delivery.status === "delivered" ? "delivered" : e.delivery.status === "dead" ? "dead" : "retry",
        nextAttemptAt: e.delivery.status === "pending" ? e.delivery.nextAttemptAt : undefined,
        deadReason: e.delivery.deadReason,
        breakerOpenedUntil: e.breakerOpenedUntil,
      }),
    );
    return d;
  });

  const publishAt = Array.from({ length: messages }, () => start + Math.floor(rng() * publishWindowMs)).sort((a, b) => a - b);
  const types = publishAt.map(() => TYPES[Math.floor(rng() * TYPES.length)]!);
  const expected = new Map<string, Set<string>>(sims.map((s) => [s.endpoint.id, new Set()]));

  let now = start;
  let next = 0;
  const runUntilIdle = async () => {
    for (;;) {
      while (next < publishAt.length && publishAt[next]! <= now) {
        const type = types[next]!;
        const { messageId } = await dispatchers[next % workers]!.publish({ type, payload: { n: next + 1 } }, now);
        for (const s of sims) {
          if (!s.endpoint.eventTypes || s.endpoint.eventTypes.includes(type)) expected.get(s.endpoint.id)!.add(messageId);
        }
        next++;
      }
      await Promise.all(dispatchers.map((d) => d.tick(now, 500)));
      const due = (await store.due(Number.MAX_SAFE_INTEGER, 1))[0]?.nextAttemptAt;
      const nextPublish = publishAt[next];
      if (due === undefined && nextPublish === undefined) return;
      now = Math.max(now + tickMs, Math.min(due ?? Infinity, nextPublish ?? Infinity));
    }
  };

  await runUntilIdle();
  const deadLettered = (await store.list({ status: "dead" })).length;
  const attemptsPhase1 = log.length;

  let redelivered = 0;
  if (!options.noRedelivery) {
    // Someone notices the dead letters and fixes the receiver's secret.
    const legacy = sims.find((s) => s.endpoint.id === "legacy")!;
    legacy.receiver = new WebhookReceiver({ secrets: legacy.endpoint.secrets, store: options.idempotencyStore?.("legacy") });
    now += 30 * MIN;
    redelivered = await dispatchers[0]!.redeliver({ endpointId: "legacy" }, now);
    await runUntilIdle();
  }

  const all = await store.list({});
  const summaries: EndpointSummary[] = sims.map((s) => {
    const id = s.endpoint.id;
    const mine = log.filter((l) => l.endpointId === id);
    const exp = expected.get(id)!;
    const processedOnce = [...exp].filter((m) => s.processed.get(m) === 1).length;
    const firstPhase = log.slice(0, attemptsPhase1).filter((l) => l.endpointId === id);
    return {
      id,
      behaviour: s.behaviour,
      expected: exp.size,
      processedOnce,
      attempts: mine.length,
      retries: mine.filter((l) => l.result === "retry").length,
      duplicatesAbsorbed: s.duplicates,
      breakerOpenings: mine.filter((l) => l.breakerOpenedUntil).length,
      deadLettered: firstPhase.filter((l) => l.result === "dead").length,
    };
  });

  const exactlyOnce = sims.every((s) => {
    const exp = expected.get(s.endpoint.id)!;
    return s.processed.size === exp.size && [...exp].every((m) => s.processed.get(m) === 1);
  });

  return {
    startedAt: start,
    finishedAt: now,
    messages,
    deliveries: all.length,
    attempts: log.length,
    retries: log.filter((l) => l.result === "retry").length,
    duplicatesAbsorbed: summaries.reduce((n, s) => n + s.duplicatesAbsorbed, 0),
    breakerOpenings: summaries.reduce((n, s) => n + s.breakerOpenings, 0),
    deadLettered,
    redelivered,
    deadRemaining: all.filter((d) => d.status === "dead").length,
    exactlyOnce,
    endpoints: summaries,
    log,
  };
}
