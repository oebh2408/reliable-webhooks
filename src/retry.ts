export interface RetryPolicy {
  /** Total requests per delivery, including the first. Default 8. */
  maxAttempts: number;
  /** Delay before the first retry. Default 5 s. */
  baseDelayMs: number;
  /** Each retry waits `factor` times longer than the previous one. Default 5. */
  factor: number;
  /** Upper bound for a single delay, including `Retry-After`. Default 6 h. */
  maxDelayMs: number;
  /** Fraction of each delay that is randomized (0 to 1). Default 0.2. */
  jitter: number;
  /** A delivery older than this is dead-lettered instead of retried. Default 3 days. */
  maxAgeMs: number;
}

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 8,
  baseDelayMs: 5_000,
  factor: 5,
  maxDelayMs: 6 * 3600_000,
  jitter: 0.2,
  maxAgeMs: 3 * 24 * 3600_000,
};

export type Outcome = "success" | "retry" | "reject" | "gone";

/**
 * What a response means for the delivery.
 *
 * - 2xx: delivered.
 * - 408, 425, 429, 5xx and no response at all: temporary, retry.
 * - 410: the receiver says the endpoint is gone; it gets disabled.
 * - Anything else (other 4xx, 3xx): retrying the same request will not
 *   change the answer, so the delivery goes to the dead letters right away.
 */
export function classify(status: number): Outcome {
  if (status >= 200 && status < 300) return "success";
  if (status === 0 || status === 408 || status === 425 || status === 429 || status >= 500) return "retry";
  if (status === 410) return "gone";
  return "reject";
}

/**
 * Delay before the next attempt, after `attempts` requests have failed.
 * Exponential, with the top `jitter` fraction randomized so that a burst of
 * failures does not retry in lockstep. A `Retry-After` header is honoured
 * when it asks for longer.
 */
export function retryDelay(policy: RetryPolicy, attempts: number, random: () => number, retryAfterMs?: number): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.factor ** Math.max(0, attempts - 1));
  const jittered = Math.round(exponential * (1 - policy.jitter * random()));
  return Math.min(policy.maxDelayMs, Math.max(jittered, retryAfterMs ?? 0));
}

/** Parses `Retry-After` (seconds or an HTTP date) into milliseconds from `now`. */
export function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
