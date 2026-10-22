import { describe, expect, it } from "vitest";
import { generateSecret, MemoryIdempotencyStore, signWebhook, WebhookReceiver, type ReceivedWebhook } from "reliable-webhooks";

const T0 = Date.parse("2026-01-12T09:00:00Z");
const SECRET = generateSecret();
const body = JSON.stringify({ type: "order.paid", timestamp: "2026-01-12T09:00:00.000Z", data: { orderId: 42 } });
const request = (id = "msg_1", at = T0, payload = body) => ({
  headers: signWebhook({ id, timestamp: Math.floor(at / 1000), body: payload, secrets: [SECRET] }),
  body: payload,
});

describe("receiver", () => {
  it("verifies, parses and runs the handler once per message id", async () => {
    const receiver = new WebhookReceiver({ secrets: [SECRET] });
    const seen: ReceivedWebhook[] = [];
    const first = await receiver.handle(request(), (e) => seen.push(e), T0);
    // A retry is signed again with a new timestamp but keeps the id.
    const retry = await receiver.handle(request("msg_1", T0 + 30_000), (e) => seen.push(e), T0 + 30_000);
    expect(first).toMatchObject({ status: 200, outcome: "processed", messageId: "msg_1" });
    expect(retry).toMatchObject({ status: 200, outcome: "duplicate" });
    expect(seen).toEqual([{ id: "msg_1", type: "order.paid", timestamp: "2026-01-12T09:00:00.000Z", data: { orderId: 42 } }]);
  });

  it("answers 401 to a bad signature or a stale request without calling the handler", async () => {
    const receiver = new WebhookReceiver({ secrets: [generateSecret()] });
    let calls = 0;
    expect(await receiver.handle(request(), () => calls++, T0)).toMatchObject({
      status: 401,
      reason: "no-matching-signature",
    });
    const right = new WebhookReceiver({ secrets: [SECRET] });
    expect(await right.handle(request("msg_1", T0), () => calls++, T0 + 10 * 60_000)).toMatchObject({
      status: 401,
      reason: "timestamp-too-old",
    });
    expect(calls).toBe(0);
  });

  it("answers 400 to a signed body that is not a webhook payload", async () => {
    const receiver = new WebhookReceiver({ secrets: [SECRET] });
    expect(await receiver.handle(request("msg_1", T0, "not json"), () => 0, T0)).toMatchObject({ status: 400, outcome: "malformed" });
    expect(await receiver.handle(request("msg_2", T0, '{"data":1}'), () => 0, T0)).toMatchObject({ status: 400 });
  });

  it("releases the claim when the handler fails, so the retry runs it again", async () => {
    const receiver = new WebhookReceiver({ secrets: [SECRET] });
    let calls = 0;
    const failing = await receiver.handle(request(), () => {
      calls++;
      throw new Error("database down");
    }, T0);
    expect(failing).toMatchObject({ status: 500, outcome: "failed" });
    expect(await receiver.handle(request(), () => calls++, T0 + 5_000)).toMatchObject({ outcome: "processed" });
    expect(calls).toBe(2);
  });

  it("asks a concurrent delivery of the same message to come back later", async () => {
    const receiver = new WebhookReceiver({ secrets: [SECRET], leaseMs: 30_000 });
    let finish!: () => void;
    const slow = receiver.handle(request(), () => new Promise<void>((r) => (finish = r)), T0);
    await new Promise((r) => setTimeout(r, 0));
    const second = await receiver.handle(request(), () => undefined, T0 + 1_000);
    expect(second).toMatchObject({ status: 503, outcome: "in-progress", headers: { "retry-after": "30" } });
    finish();
    expect(await slow).toMatchObject({ outcome: "processed" });
  });

  it("lets another delivery take over when a handler's lease expired", async () => {
    const store = new MemoryIdempotencyStore();
    expect(await store.claim("msg_1", T0, 30_000)).toBe("claimed");
    expect(await store.claim("msg_1", T0 + 29_999, 30_000)).toBe("in-progress");
    expect(await store.claim("msg_1", T0 + 30_000, 30_000)).toBe("claimed");
  });

  it("forgets processed ids after retainMs", async () => {
    const store = new MemoryIdempotencyStore();
    await store.claim("msg_1", T0, 1_000);
    await store.complete("msg_1", T0, 3600_000);
    expect(await store.claim("msg_1", T0 + 3599_999, 1_000)).toBe("duplicate");
    expect(await store.claim("msg_2", T0 + 2 * 3600_000, 1_000)).toBe("claimed");
    expect(store.size).toBe(1);
  });
});
