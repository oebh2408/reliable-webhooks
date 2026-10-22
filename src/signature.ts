import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signatures follow the Standard Webhooks format (https://www.standardwebhooks.com),
 * so receivers can use any compatible library:
 *
 *   webhook-id:        msg_2b8d...
 *   webhook-timestamp: 1767258325          (seconds)
 *   webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">  [v1,<...> ...]
 *
 * Several signatures, separated by spaces, allow secret rotation.
 */

export type HeaderBag =
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

export type SignedHeaders = {
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
};

export type VerificationFailure =
  | "missing-headers"
  | "bad-timestamp"
  | "timestamp-too-old"
  | "timestamp-too-new"
  | "no-matching-signature";

export class WebhookVerificationError extends Error {
  constructor(readonly reason: VerificationFailure) {
    super(`webhook verification failed: ${reason}`);
    this.name = "WebhookVerificationError";
  }
}

const PREFIX = "whsec_";

/** A new random secret in the `whsec_<base64>` format. */
export function generateSecret(bytes = 24): string {
  return PREFIX + randomBytes(bytes).toString("base64");
}

function key(secret: string): Buffer {
  return secret.startsWith(PREFIX) ? Buffer.from(secret.slice(PREFIX.length), "base64") : Buffer.from(secret, "utf8");
}

function hmac(secret: string, id: string, timestamp: number, body: string): string {
  return createHmac("sha256", key(secret)).update(`${id}.${timestamp}.${body}`).digest("base64");
}

/** Signs `body` with every secret. `timestamp` is in seconds. */
export function signWebhook(input: { id: string; timestamp: number; body: string; secrets: string[] }): SignedHeaders {
  if (!input.secrets.length) throw new Error("at least one secret is required");
  return {
    "webhook-id": input.id,
    "webhook-timestamp": String(input.timestamp),
    "webhook-signature": input.secrets.map((s) => `v1,${hmac(s, input.id, input.timestamp, input.body)}`).join(" "),
  };
}

export function header(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(n: string): string | null }).get(name) ?? undefined;
  }
  const bag = headers as Record<string, string | string[] | undefined>;
  const found = bag[name] ?? Object.entries(bag).find(([k]) => k.toLowerCase() === name)?.[1];
  return Array.isArray(found) ? found[0] : found;
}

export interface VerifyOptions {
  headers: HeaderBag;
  /** The raw request body, exactly as received. Parsing and re-serializing breaks the signature. */
  body: string;
  /** Accepted secrets. Any match is enough. */
  secrets: string[];
  /** Current time in milliseconds. Defaults to `Date.now()`. */
  now?: number;
  /** How far the timestamp may be from `now`, either way. Default 5 minutes. */
  toleranceMs?: number;
}

/**
 * Checks the signature and the timestamp. Returns the message id and timestamp,
 * or throws {@link WebhookVerificationError}.
 */
export function verifyWebhook(options: VerifyOptions): { id: string; timestamp: number } {
  const { headers, body, secrets, now = Date.now(), toleranceMs = 5 * 60_000 } = options;
  const id = header(headers, "webhook-id");
  const rawTimestamp = header(headers, "webhook-timestamp");
  const signatures = header(headers, "webhook-signature");
  if (!id || !rawTimestamp || !signatures) throw new WebhookVerificationError("missing-headers");

  if (!/^\d+$/.test(rawTimestamp)) throw new WebhookVerificationError("bad-timestamp");
  const timestamp = Number(rawTimestamp);
  if (timestamp * 1000 < now - toleranceMs) throw new WebhookVerificationError("timestamp-too-old");
  if (timestamp * 1000 > now + toleranceMs) throw new WebhookVerificationError("timestamp-too-new");

  const candidates = signatures
    .split(" ")
    .filter((s) => s.startsWith("v1,"))
    .map((s) => Buffer.from(s.slice(3), "base64"));
  for (const secret of secrets) {
    const expected = Buffer.from(hmac(secret, id, timestamp, body), "base64");
    if (candidates.some((c) => c.length === expected.length && timingSafeEqual(c, expected))) {
      return { id, timestamp };
    }
  }
  throw new WebhookVerificationError("no-matching-signature");
}
