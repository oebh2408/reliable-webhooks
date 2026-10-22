import { describe, expect, it } from "vitest";
import {
  generateSecret,
  MemoryDeliveryStore,
  verifyWebhook,
  WebhookDispatcher,
  type Delivery,
  type DispatcherOptions,
  type Endpoint,
  type OutgoingRequest,
  type TransportResponse,
} from "reliable-webhooks";

const T0 = Date.parse("2026-01-12T09:00:00Z");
const SECRET = generateSecret();
const endpoint: Endpoint = { id: "shop", url: "https://shop.example.test/hooks", secrets: [SECRET] };

type Reply = TransportResponse | Error | Promise<TransportResponse>;

function setup(reply: (req: OutgoingRequest, n: number) => Reply, options: Partial<DispatcherOptions> = {}) {
  const store = new MemoryDeliveryStore();
  const requests: OutgoingRequest[] = [];
  const dispatcher = new WebhookDispatcher({
    store,
    endpoints: [endpoint],
    transport: async (req) => {
      requests.push(req);
      const r = reply(req, requests.length);
      if (r instanceof Error) throw r;
      return r;
    },
    random: () => 0,
    ...options,
  });
  return { store, dispatcher, requests };
}

const ok = () => ({ status: 200 });
const only = async (store: MemoryDeliveryStore): Promise<Delivery> => (await store.list({}))[0]!;

describe("dispatcher", () => {
  it("stores on publish and sends a signed request on tick", async () => {
    const { store, dispatcher, requests } = setup(ok);
    const { messageId } = await dispatcher.publish({ type: "order.paid", payload: { orderId: 42 } }, T0);
    expect(requests).toHaveLength(0);

    const report = await dispatcher.tick(T0);
    expect(report).toMatchObject({ attempted: 1, delivered: 1 });
    const [req] = requests;
    expect(req!.headers["content-type"]).toBe("application/json");
    expect(verifyWebhook({ headers: req!.headers, body: req!.body, secrets: [SECRET], now: T0 }).id).toBe(messageId);
    expect(JSON.parse(req!.body)).toEqual({ type: "order.paid", timestamp: "2026-01-12T09:00:00.000Z", data: { orderId: 42 } });
    expect(await only(store)).toMatchObject({ status: "delivered", attempts: 1, deliveredAt: T0 });
  });

  it("fans out to subscribed endpoints only, and publishing the same id twice is a no-op", async () => {
    const { store, dispatcher } = setup(ok);
    dispatcher.setEndpoints([endpoint, { ...endpoint, id: "billing", eventTypes: ["invoice.issued"] }]);
    await dispatcher.publish({ id: "msg_a", type: "order.paid", payload: {} }, T0);
    await dispatcher.publish({ id: "msg_b", type: "invoice.issued", payload: {} }, T0);
    const again = await dispatcher.publish({ id: "msg_b", type: "invoice.issued", payload: {} }, T0);
    expect(again.deliveries).toEqual([]);
    expect((await store.list({})).map((d) => d.id).sort()).toEqual(["msg_a:shop", "msg_b:billing", "msg_b:shop"]);
  });

  it("retries with exponential backoff, re-signing each attempt with the same id", async () => {
    const { store, dispatcher, requests } = setup((_, n) => (n < 3 ? { status: 503 } : ok()));
    await dispatcher.publish({ type: "order.paid", payload: {} }, T0);
    await dispatcher.tick(T0);
    expect(await only(store)).toMatchObject({ status: "pending", attempts: 1, nextAttemptAt: T0 + 5_000 });

    await dispatcher.tick(T0 + 4_999);
    expect(requests).toHaveLength(1);
    await dispatcher.tick(T0 + 5_000);
    expect(await only(store)).toMatchObject({ status: "pending", attempts: 2, nextAttemptAt: T0 + 30_000 });
    await dispatcher.tick(T0 + 30_000);
    expect(await only(store)).toMatchObject({ status: "delivered", attempts: 3 });

    expect(new Set(requests.map((r) => r.headers["webhook-id"])).size).toBe(1);
    expect(requests.map((r) => r.headers["webhook-timestamp"])).toEqual(
      [T0, T0 + 5_000, T0 + 30_000].map((t) => String(t / 1000)),
    );
    expect((await only(store)).history.map((a) => a.status)).toEqual([503, 503, 200]);
  });

  it("waits as long as Retry-After asks", async () => {
    const { store, dispatcher } = setup((_, n) => (n === 1 ? { status: 429, headers: { "retry-after": "90" } } : ok()));
    await dispatcher.publish({ type: "order.paid", payload: {} }, T0);
    await dispatcher.tick(T0);
    expect((await only(store)).nextAttemptAt).toBe(T0 + 90_000);
  });

  it("records network errors and timeouts as status 0 and retries them", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const { store, dispatcher } = setup((_, n) => (n === 1 ? refused : timeout));
    await dispatcher.publish({ type: "order.paid", payload: {} }, T0);
    await dispatcher.tick(T0);
    await dispatcher.tick(T0 + 5_000);
    expect((await only(store)).history.map((a) => [a.status, a.error])).toEqual([
      [0, "ECONNREFUSED"],
      [0, "timeout"],
    ]);
  });

  it("dead-letters a 4xx right away and tells listeners", async () => {
    const { store, dispatcher } = setup(() => ({ status: 401 }));
    const dead: Delivery[] = [];
    dispatcher.onDead((d) => dead.push(d));
    await dispatcher.publish({ type: "order.paid", payload: {} }, T0);
    expect(await dispatcher.tick(T0)).toMatchObject({ attempted: 1, dead: 1, retried: 0 });
    expect(await only(store)).toMatchObject({ status: "dead", deadReason: "rejected", deadAt: T0 });
    expect(dead.map((d) => d.deadReason)).toEqual(["rejected"]);
  });

  it("dead-letters after maxAttempts", async () => {
    const { store, dispatcher } = setup(() => ({ status: 500 }), { retry: { maxAttempts: 3 }, breaker: false });
    await dispatcher.publish({ type: "order.paid", payload: {} }, T0);
    for (const t of [0, 5_000, 30_000, 155_000]) await dispatcher.tick(T0 + t);
    expect(await only(store)).toMatchObject({ status: "dead", deadReason: "exhausted", attempts: 3 });
  });

  it("dead-letters when the next attempt would fall past maxAgeMs", async () => {
    const { store, dispatcher } = setup(() => ({ status: 500 }), { retry: { maxAgeMs: 20_000 }, breaker: false });
    await dispatcher.publish({ type: "order.paid", payload: {} }, T0);
    await dispatcher.tick(T0);
    await dispatcher.tick(T0 + 5_000);
    expect(await only(store)).toMatchObject({ status: "dead", deadReason: "expired", attempts: 2 });
  });

  it("disables an endpoint that answers 410 until it is enabled again", async () => {
    const { store, dispatcher, requests } = setup((_, n) => (n === 1 ? { status: 410 } : ok()));
    await dispatcher.publish({ id: "msg_1", type: "a", payload: {} }, T0);
    await dispatcher.publish({ id: "msg_2", type: "a", payload: {} }, T0 + 1);
    await dispatcher.tick(T0 + 1);
    expect(requests).toHaveLength(1);
    expect((await store.get("msg_1:shop"))!.deadReason).toBe("gone");
    expect((await store.get("msg_2:shop"))!.deadReason).toBe("endpoint-unavailable");
    expect((await dispatcher.publish({ type: "a", payload: {} }, T0 + 2)).deliveries).toEqual([]);

    await dispatcher.enableEndpoint("shop");
    expect(await dispatcher.redeliver({}, T0 + 3)).toBe(2);
    await dispatcher.tick(T0 + 3);
    expect((await store.list({ status: "delivered" })).length).toBe(2);
  });

  it("opens the breaker after consecutive failures and probes once after the cooldown", async () => {
    let up = false;
    const { store, dispatcher, requests } = setup(() => (up ? ok() : { status: 503 }), {
      breaker: { failureThreshold: 3, cooldownMs: 60_000 },
    });
    for (let i = 0; i < 10; i++) await dispatcher.publish({ id: `msg_${i}`, type: "a", payload: {} }, T0);

    const first = await dispatcher.tick(T0);
    expect(first).toMatchObject({ attempted: 3, postponed: 7 });
    expect((await store.getEndpointState("shop"))!.openUntil).toBe(T0 + 60_000);

    // Retries that come due while the breaker is open are postponed, not attempted.
    expect(await dispatcher.tick(T0 + 5_000)).toMatchObject({ attempted: 0, postponed: 3 });

    // After the cooldown one request goes through; it fails and the breaker reopens for twice as long.
    expect(await dispatcher.tick(T0 + 60_000)).toMatchObject({ attempted: 1 });
    expect(requests).toHaveLength(4);
    await dispatcher.tick(T0 + 60_000);
    await dispatcher.tick(T0 + 60_000);
    expect((await store.getEndpointState("shop"))!.openUntil).toBe(T0 + 180_000);

    up = true;
    await dispatcher.tick(T0 + 180_000);
    expect((await store.list({ status: "delivered" })).length).toBe(10);
    expect((await store.getEndpointState("shop"))!).toMatchObject({ failures: 0, openUntil: 0, opened: 0 });
    // Postponements did not use up attempts.
    expect(Math.max(...(await store.list({})).map((d) => d.attempts))).toBeLessThanOrEqual(3);
  });

  it("takes over a delivery whose worker stopped mid-request, after the lease", async () => {
    const store = new MemoryDeliveryStore();
    const sent: string[] = [];
    let release!: (r: TransportResponse) => void;
    const stuck = new WebhookDispatcher({
      store,
      endpoints: [endpoint],
      transport: (req) => {
        sent.push(req.headers["webhook-id"]!);
        return new Promise((r) => (release = r));
      },
    });
    const healthy = new WebhookDispatcher({
      store,
      endpoints: [endpoint],
      transport: async (req) => (sent.push(req.headers["webhook-id"]!), { status: 200 }),
    });
    await stuck.publish({ id: "msg_1", type: "a", payload: {} }, T0);
    const hanging = stuck.tick(T0);
    await new Promise((r) => setTimeout(r, 0));

    expect(await healthy.tick(T0 + 59_999)).toMatchObject({ attempted: 0 });
    expect(await healthy.tick(T0 + 60_000)).toMatchObject({ delivered: 1 });

    release({ status: 200 });
    expect(await hanging).toMatchObject({ conflicts: 1, delivered: 0 });
    // At least once: the receiver saw the message twice, with the same id.
    expect(sent).toEqual(["msg_1", "msg_1"]);
    expect((await store.get("msg_1:shop"))!.status).toBe("delivered");
  });

  it("lets several dispatchers share a store without sending anything twice", async () => {
    const store = new MemoryDeliveryStore();
    const sent: string[] = [];
    const workers = [1, 2, 3].map(
      () =>
        new WebhookDispatcher({
          store,
          endpoints: [endpoint, { ...endpoint, id: "crm", url: "https://crm.example.test/hooks" }],
          transport: async (req) => (sent.push(`${req.headers["webhook-id"]} ${req.url}`), { status: 200 }),
        }),
    );
    for (let i = 0; i < 40; i++) await workers[i % 3]!.publish({ type: "a", payload: { i } }, T0);
    const reports = await Promise.all(workers.map((w) => w.tick(T0, 1_000)));
    expect(reports.reduce((n, r) => n + r.delivered, 0)).toBe(80);
    expect(sent).toHaveLength(80);
    expect(new Set(sent).size).toBe(80);
  });

  it("redelivers dead letters with a fresh retry cycle", async () => {
    let fixed = false;
    const { store, dispatcher } = setup(() => (fixed ? ok() : { status: 401 }), { retry: { maxAgeMs: 60_000 } });
    await dispatcher.publish({ type: "a", payload: {} }, T0);
    await dispatcher.tick(T0);
    expect(await dispatcher.deadLetters()).toHaveLength(1);

    fixed = true;
    const later = T0 + 24 * 3600_000;
    expect(await dispatcher.redeliver({ endpointId: "shop" }, later)).toBe(1);
    await dispatcher.tick(later);
    expect(await only(store)).toMatchObject({ status: "delivered", attempts: 1, cycleStartedAt: later, createdAt: T0 });
    expect((await only(store)).history.map((a) => a.status)).toEqual([401, 200]);
  });

  it("dead-letters deliveries to an endpoint that was removed", async () => {
    const { store, dispatcher, requests } = setup(ok);
    await dispatcher.publish({ type: "a", payload: {} }, T0);
    dispatcher.setEndpoints([]);
    await dispatcher.tick(T0);
    expect(requests).toHaveLength(0);
    expect((await only(store)).deadReason).toBe("endpoint-unavailable");
  });

  it("requires the lease to outlast the timeout", () => {
    expect(() => setup(ok, { timeoutMs: 60_000, leaseMs: 30_000 })).toThrow(/leaseMs/);
  });
});
