/** Where and how to deliver webhooks for one subscriber. */
export interface Endpoint {
  id: string;
  url: string;
  /** Free text shown in the dashboard. */
  description?: string;
  /**
   * While paused, deliveries are kept and postponed without using up
   * attempts. `maxAgeMs` still applies.
   */
  paused?: boolean;
  /**
   * Signing secrets, newest first. Every secret signs every request, so a
   * receiver can rotate by adding the new secret before removing the old one.
   */
  secrets: string[];
  /** Event types this endpoint receives. Omitted means all of them. */
  eventTypes?: string[];
  /** Extra request headers, for example a static auth token. */
  headers?: Record<string, string>;
  /** Overrides the dispatcher's request timeout for this endpoint. */
  timeoutMs?: number;
  /**
   * Requests per second this endpoint accepts. Deliveries beyond it wait,
   * without using up attempts. Enforced per dispatcher. Unset means no limit.
   */
  rateLimit?: number;
  /** Requests in flight to this endpoint at once, per dispatcher. Default 1, at most 50. */
  maxConcurrency?: number;
}

/** An event to publish. The body is serialized once and never changes. */
export interface WebhookEvent {
  type: string;
  payload: unknown;
  /** Message id sent as `webhook-id`. Generated when omitted. Reusing an id makes publishing idempotent. */
  id?: string;
  /** Send only to these endpoints, whatever event types they subscribe to. For test events. */
  endpointIds?: string[];
}

export type DeliveryStatus = "pending" | "sending" | "delivered" | "dead";

export type DeadReason =
  /** The endpoint answered with a 4xx that retrying will not fix. */
  | "rejected"
  /** The endpoint answered 410 Gone and was disabled. */
  | "gone"
  /** Every attempt failed. */
  | "exhausted"
  /** The delivery is older than `maxAgeMs`. */
  | "expired"
  /** The endpoint was removed or disabled before the delivery was sent. */
  | "endpoint-unavailable";

export interface Attempt {
  at: number;
  /** HTTP status, or 0 when no response was received. */
  status: number;
  /** "timeout", "network" or a short message, when no response was received. */
  error?: string;
  durationMs: number;
}

/** One message on its way to one endpoint. */
export interface Delivery {
  /** `${messageId}:${endpointId}` */
  id: string;
  messageId: string;
  endpointId: string;
  eventType: string;
  /** The exact bytes that are signed and sent. */
  body: string;
  createdAt: number;
  /** Start of the current retry cycle: `createdAt`, or when it was last redelivered. `maxAgeMs` counts from here. */
  cycleStartedAt: number;
  status: DeliveryStatus;
  /** Requests sent so far, not counting postponements by the circuit breaker. */
  attempts: number;
  /**
   * When the delivery next needs attention. For `pending` it is the next
   * attempt; for `sending` it is when the lease expires and another worker may
   * take over.
   */
  nextAttemptAt: number;
  /** The most recent attempts, oldest first (bounded by `historyLimit`). */
  history: Attempt[];
  deliveredAt?: number;
  deadAt?: number;
  deadReason?: DeadReason;
  /** Incremented on every write; used for conditional updates. */
  version: number;
}

/** Circuit breaker and enable/disable state, kept per endpoint. */
export interface EndpointState {
  endpointId: string;
  /** Consecutive failed attempts. Reset by any success. */
  failures: number;
  /** While `now < openUntil`, deliveries to this endpoint are postponed. */
  openUntil: number;
  /** How many times in a row the breaker has opened; drives the cooldown. */
  opened: number;
  disabled: boolean;
}

/** What a transport sends. */
export interface OutgoingRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  /** The dispatcher's clock, for transports that simulate time. */
  now: number;
}

export interface TransportResponse {
  status: number;
  headers?: Record<string, string | undefined>;
  durationMs?: number;
}

/**
 * Sends one HTTP POST. Resolves with any response, whatever the status.
 * Rejects when no response arrived (timeout, connection refused, DNS); the
 * error's `code` or `name` is recorded in the attempt.
 */
export type Transport = (request: OutgoingRequest) => Promise<TransportResponse>;
