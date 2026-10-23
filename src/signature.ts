import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual, verify, type KeyObject } from "node:crypto";

/**
 * Signatures follow the Standard Webhooks format (https://www.standardwebhooks.com),
 * so receivers can use any compatible library:
 *
 *   webhook-id:        msg_2b8d...
 *   webhook-timestamp: 1767258325          (seconds)
 *   webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">  [v1,<...> ...]
 *
 * Several signatures, separated by spaces, allow secret rotation.
 *
 * Secrets starting with `whsk_` are ed25519 private keys and sign with `v1a`
 * instead; receivers verify those with the matching `whpk_` public key, so
 * they never hold anything that can sign. See ADR 0010.
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
const PRIVATE_PREFIX = "whsk_";
const PUBLIC_PREFIX = "whpk_";
// DER headers that turn a raw 32-byte ed25519 key into PKCS#8 / SPKI.
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** A new random secret in the `whsec_<base64>` format. */
export function generateSecret(bytes = 24): string {
  return PREFIX + randomBytes(bytes).toString("base64");
}

/**
 * A new ed25519 key pair. `secretKey` (`whsk_` and the base64 32-byte seed)
 * goes in the endpoint's `secrets`; `publicKey` (`whpk_` and the base64 raw
 * 32-byte key) is what the receiver verifies with.
 */
export function generateKeyPair(): { secretKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_ED25519.length);
  return { secretKey: PRIVATE_PREFIX + seed.toString("base64"), publicKey: publicKeyOf(publicKey) };
}

/** The `whpk_` public key for a `whsk_` secret key. */
export function publicKeyFor(secretKey: string): string {
  return publicKeyOf(createPublicKey(privateKey(secretKey)));
}

export function isSecretKey(secret: string): boolean {
  return secret.startsWith(PRIVATE_PREFIX);
}

function publicKeyOf(key: KeyObject): string {
  return PUBLIC_PREFIX + key.export({ format: "der", type: "spki" }).subarray(SPKI_ED25519.length).toString("base64");
}

function rawKey(value: string, prefix: string): Buffer {
  const raw = Buffer.from(value.slice(prefix.length), "base64");
  if (raw.length !== 32) throw new Error(`${prefix} keys are 32 bytes, base64 encoded`);
  return raw;
}

function privateKey(secretKey: string): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, rawKey(secretKey, PRIVATE_PREFIX)]), format: "der", type: "pkcs8" });
}

function publicKey(value: string): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, rawKey(value, PUBLIC_PREFIX)]), format: "der", type: "spki" });
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
    "webhook-signature": input.secrets
      .map((s) => {
        if (!isSecretKey(s)) return `v1,${hmac(s, input.id, input.timestamp, input.body)}`;
        const content = Buffer.from(`${input.id}.${input.timestamp}.${input.body}`);
        return `v1a,${sign(null, content, privateKey(s)).toString("base64")}`;
      })
      .join(" "),
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
  /** Accepted `whsec_` secrets and `whpk_` public keys. Any match is enough. */
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

  const parts = signatures.split(" ");
  const candidates = parts.filter((s) => s.startsWith("v1,")).map((s) => Buffer.from(s.slice(3), "base64"));
  const asymmetric = parts.filter((s) => s.startsWith("v1a,")).map((s) => Buffer.from(s.slice(4), "base64"));
  for (const secret of secrets) {
    if (secret.startsWith(PUBLIC_PREFIX)) {
      const content = Buffer.from(`${id}.${timestamp}.${body}`);
      const key = publicKey(secret);
      if (asymmetric.some((sig) => sig.length === 64 && verify(null, content, key, sig))) return { id, timestamp };
      continue;
    }
    if (isSecretKey(secret)) throw new Error("verify with the whpk_ public key, not the whsk_ secret key");
    const expected = Buffer.from(hmac(secret, id, timestamp, body), "base64");
    if (candidates.some((c) => c.length === expected.length && timingSafeEqual(c, expected))) {
      return { id, timestamp };
    }
  }
  throw new WebhookVerificationError("no-matching-signature");
}
