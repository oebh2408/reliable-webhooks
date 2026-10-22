import { type HeaderBag, verifyWebhook, WebhookVerificationError } from "./signature.js";

export type ClaimResult = "claimed" | "duplicate" | "in-progress";

/**
 * Remembers which message ids were processed. `claim` must be atomic: in SQL,
 * an `INSERT ... ON CONFLICT` or a conditional update; in a key-value store,
 * a set-if-absent.
 */
export interface IdempotencyStore {
  /**
   * - No record, or an expired one: create it as processing until `now + leaseMs` and return `"claimed"`.
   * - Processing with a lease that expired (the previous handler died): take it over, `"claimed"`.
   * - Processing with a live lease: `"in-progress"`.
   * - Completed: `"duplicate"`.
   */
  claim(id: string, now: number, leaseMs: number): Promise<ClaimResult>;
  /** Marks the id as processed and keeps it until `now + retainMs`. */
  complete(id: string, now: number, retainMs: number): Promise<void>;
  /** Forgets a claim after the handler failed, so the next retry runs it again. */
  release(id: string): Promise<void>;
}

/** Reference store kept in process memory. Expired ids are purged as it goes. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly rows = new Map<string, { done: boolean; until: number }>();
  private lastPurge = 0;

  get size(): number {
    return this.rows.size;
  }

  async claim(id: string, now: number, leaseMs: number): Promise<ClaimResult> {
    this.purge(now);
    const row = this.rows.get(id);
    if (row && row.until > now) return row.done ? "duplicate" : "in-progress";
    this.rows.set(id, { done: false, until: now + leaseMs });
    return "claimed";
  }

  async complete(id: string, now: number, retainMs: number): Promise<void> {
    this.rows.set(id, { done: true, until: now + retainMs });
  }

  async release(id: string): Promise<void> {
    this.rows.delete(id);
  }

  private purge(now: number): void {
    if (now - this.lastPurge < 60_000) return;
    this.lastPurge = now;
    for (const [id, row] of this.rows) if (row.until <= now) this.rows.delete(id);
  }
}

export interface ReceivedWebhook {
  /** The message id. The same across retries of one message. */
  id: string;
  type: string;
  /** When the event was published, as sent in the body. */
  timestamp: string;
  data: unknown;
}

export type ReceiveOutcome = "processed" | "duplicate" | "in-progress" | "invalid-signature" | "malformed" | "failed";

export interface ReceiveResult {
  /** HTTP status to answer with. */
  status: number;
  outcome: ReceiveOutcome;
  messageId?: string;
  headers?: Record<string, string>;
  /** Why verification failed, or the handler's error. */
  reason?: string;
  error?: unknown;
}

export interface ReceiverOptions {
  /** Accepted secrets. During a rotation, list both. */
  secrets: string[];
  /** Allowed clock difference with the sender. Default 5 minutes. */
  toleranceMs?: number;
  store?: IdempotencyStore;
  /** How long a handler may run before another delivery of the same message may take over. Default 60 s. */
  leaseMs?: number;
  /**
   * How long processed ids are remembered. Must cover the sender's whole
   * retry window, or a late retry is processed twice. Default 4 days.
   */
  retainMs?: number;
}

/**
 * Verifies incoming webhooks and runs the handler at most once per message id,
 * as long as the id is retained. Senders retry, so receivers see the same
 * message more than once; this is where that is absorbed. See ADR 0003.
 *
 * Answers:
 * - 200 processed, or a duplicate of something already processed.
 * - 401 bad signature or stale timestamp. Retrying will not help.
 * - 400 body is not a webhook payload.
 * - 503 with `Retry-After` while another delivery of the same message is still running.
 * - 500 the handler threw. The claim is released so the sender's retry runs it again.
 */
export class WebhookReceiver {
  private readonly secrets: string[];
  private readonly toleranceMs: number;
  private readonly store: IdempotencyStore;
  private readonly leaseMs: number;
  private readonly retainMs: number;

  constructor(options: ReceiverOptions) {
    this.secrets = options.secrets;
    this.toleranceMs = options.toleranceMs ?? 5 * 60_000;
    this.store = options.store ?? new MemoryIdempotencyStore();
    this.leaseMs = options.leaseMs ?? 60_000;
    this.retainMs = options.retainMs ?? 4 * 24 * 3600_000;
  }

  async handle(
    request: { headers: HeaderBag; body: string },
    handler: (event: ReceivedWebhook) => unknown | Promise<unknown>,
    now = Date.now(),
  ): Promise<ReceiveResult> {
    let id: string;
    try {
      ({ id } = verifyWebhook({ ...request, secrets: this.secrets, now, toleranceMs: this.toleranceMs }));
    } catch (err) {
      if (err instanceof WebhookVerificationError) return { status: 401, outcome: "invalid-signature", reason: err.reason };
      throw err;
    }

    let event: ReceivedWebhook;
    try {
      const parsed = JSON.parse(request.body);
      if (typeof parsed?.type !== "string") throw new Error("missing type");
      event = { id, type: parsed.type, timestamp: parsed.timestamp, data: parsed.data };
    } catch (err) {
      return { status: 400, outcome: "malformed", messageId: id, reason: (err as Error).message };
    }

    const claim = await this.store.claim(id, now, this.leaseMs);
    if (claim === "duplicate") return { status: 200, outcome: "duplicate", messageId: id };
    if (claim === "in-progress") {
      const seconds = String(Math.ceil(this.leaseMs / 1000));
      return { status: 503, outcome: "in-progress", messageId: id, headers: { "retry-after": seconds } };
    }

    try {
      await handler(event);
    } catch (error) {
      await this.store.release(id);
      return { status: 500, outcome: "failed", messageId: id, error };
    }
    await this.store.complete(id, now, this.retainMs);
    return { status: 200, outcome: "processed", messageId: id };
  }
}
