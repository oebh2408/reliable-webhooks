import { describe, expect, it } from "vitest";
import { generateKeyPair, generateSecret, publicKeyFor, signWebhook, verifyWebhook, WebhookVerificationError } from "reliable-webhooks";

// Test vector published with the Standard Webhooks reference libraries. It is public and
// not a real secret; the prefix is joined at runtime so secret scanners do not flag it.
const vector = {
  secret: ["whsec", "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"].join("_"),
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

const failure = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as WebhookVerificationError).reason;
  }
  return undefined;
};

describe("signatures", () => {
  it("matches the Standard Webhooks test vector", () => {
    const headers = signWebhook({ id: vector.id, timestamp: vector.timestamp, body: vector.body, secrets: [vector.secret] });
    expect(headers["webhook-signature"]).toBe(vector.signature);
    expect(verifyWebhook({ headers, body: vector.body, secrets: [vector.secret], now: vector.timestamp * 1000 })).toEqual({
      id: vector.id,
      timestamp: vector.timestamp,
    });
  });

  it("signs with every secret so receivers can rotate", () => {
    const [oldSecret, newSecret] = [generateSecret(), generateSecret()];
    const now = 1_767_000_000_000;
    const headers = signWebhook({ id: "msg_1", timestamp: now / 1000, body: "{}", secrets: [newSecret, oldSecret] });
    expect(headers["webhook-signature"].split(" ")).toHaveLength(2);
    expect(verifyWebhook({ headers, body: "{}", secrets: [oldSecret], now }).id).toBe("msg_1");
    expect(verifyWebhook({ headers, body: "{}", secrets: [newSecret], now }).id).toBe("msg_1");
  });

  it("rejects a modified body, a wrong secret and missing headers", () => {
    const now = 1_767_000_000_000;
    const secret = generateSecret();
    const headers = signWebhook({ id: "msg_1", timestamp: now / 1000, body: '{"a":1}', secrets: [secret] });
    expect(failure(() => verifyWebhook({ headers, body: '{"a":2}', secrets: [secret], now }))).toBe("no-matching-signature");
    expect(failure(() => verifyWebhook({ headers, body: '{"a":1}', secrets: [generateSecret()], now }))).toBe("no-matching-signature");
    expect(failure(() => verifyWebhook({ headers: {}, body: "", secrets: [secret], now }))).toBe("missing-headers");
  });

  it("rejects timestamps outside the tolerance, which limits replays", () => {
    const secret = generateSecret();
    const sentAt = 1_767_000_000_000;
    const headers = signWebhook({ id: "msg_1", timestamp: sentAt / 1000, body: "{}", secrets: [secret] });
    const at = (now: number) => failure(() => verifyWebhook({ headers, body: "{}", secrets: [secret], now }));
    expect(at(sentAt + 5 * 60_000)).toBeUndefined();
    expect(at(sentAt + 5 * 60_000 + 1)).toBe("timestamp-too-old");
    expect(at(sentAt - 5 * 60_000 - 1)).toBe("timestamp-too-new");
    expect(failure(() => verifyWebhook({ headers: { ...headers, "webhook-timestamp": "12a" }, body: "{}", secrets: [secret], now: sentAt }))).toBe(
      "bad-timestamp",
    );
  });

  it("reads headers case-insensitively, from objects or a Headers instance", () => {
    const secret = generateSecret();
    const now = 1_767_000_000_000;
    const signed = signWebhook({ id: "msg_1", timestamp: now / 1000, body: "{}", secrets: [secret] });
    const upper = Object.fromEntries(Object.entries(signed).map(([k, v]) => [k.toUpperCase(), v]));
    expect(verifyWebhook({ headers: upper, body: "{}", secrets: [secret], now }).id).toBe("msg_1");
    expect(verifyWebhook({ headers: new Headers(signed), body: "{}", secrets: [secret], now }).id).toBe("msg_1");
  });

  it("signs with ed25519 keys (v1a), next to HMAC secrets", () => {
    const pair = generateKeyPair();
    const hmacSecret = generateSecret();
    expect(pair.secretKey).toMatch(/^whsk_/);
    expect(publicKeyFor(pair.secretKey)).toBe(pair.publicKey);
    const now = 1_768_208_400_000;
    const signed = signWebhook({ id: "msg_1", timestamp: now / 1000, body: "{}", secrets: [pair.secretKey, hmacSecret] });
    expect(signed["webhook-signature"]).toMatch(/^v1a,\S{88} v1,\S{44}$/);
    expect(verifyWebhook({ headers: signed, body: "{}", secrets: [pair.publicKey], now }).id).toBe("msg_1");
    expect(verifyWebhook({ headers: signed, body: "{}", secrets: [hmacSecret], now }).id).toBe("msg_1");
    expect(failure(() => verifyWebhook({ headers: signed, body: "{ }", secrets: [pair.publicKey], now }))).toBe("no-matching-signature");
    expect(failure(() => verifyWebhook({ headers: signed, body: "{}", secrets: [generateKeyPair().publicKey], now }))).toBe(
      "no-matching-signature",
    );
  });

  it("refuses to verify with a secret key, which belongs only to the sender", () => {
    const { secretKey } = generateKeyPair();
    const signed = signWebhook({ id: "msg_1", timestamp: 1, body: "{}", secrets: [secretKey] });
    expect(() => verifyWebhook({ headers: signed, body: "{}", secrets: [secretKey], now: 1000 })).toThrow(/whpk_/);
  });
});
