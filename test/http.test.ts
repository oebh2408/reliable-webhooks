import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  BlockedAddressError,
  fetchTransport,
  generateSecret,
  httpTransport,
  isPrivateAddress,
  MemoryDeliveryStore,
  nodeHandler,
  WebhookDispatcher,
  WebhookReceiver,
} from "reliable-webhooks";

const SECRET = generateSecret();
let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/hooks`;
}

describe("over real HTTP", () => {
  it("delivers through fetch to a node:http receiver, once", async () => {
    const received: unknown[] = [];
    let requests = 0;
    const receiver = new WebhookReceiver({ secrets: [SECRET] });
    const handle = nodeHandler(receiver, (e) => void received.push(e.data));
    const url = await listen((req, res) => {
      requests++;
      // The first request fails before reaching the receiver; the retry goes through.
      if (requests === 1) return void res.writeHead(503).end();
      void handle(req, res);
    });

    const store = new MemoryDeliveryStore();
    const dispatcher = new WebhookDispatcher({ store, endpoints: [{ id: "local", url, secrets: [SECRET] }], transport: fetchTransport() });
    await dispatcher.publish({ type: "order.paid", payload: { orderId: 7 } });
    await dispatcher.tick();
    const d = (await store.list({}))[0]!;
    expect(d.status).toBe("pending");
    await dispatcher.tick(d.nextAttemptAt);
    expect((await store.list({}))[0]!.status).toBe("delivered");
    expect(received).toEqual([{ orderId: 7 }]);
  });

  it("records a timeout when the receiver is too slow", async () => {
    const url = await listen(() => undefined);
    const store = new MemoryDeliveryStore();
    const dispatcher = new WebhookDispatcher({
      store,
      endpoints: [{ id: "slow", url, secrets: [SECRET], timeoutMs: 100 }],
      transport: fetchTransport(),
    });
    await dispatcher.publish({ type: "a", payload: {} });
    await dispatcher.tick();
    expect((await store.list({}))[0]!.history[0]).toMatchObject({ status: 0, error: "timeout" });
    server!.closeAllConnections();
  });

  it("does not follow redirects", async () => {
    const url = await listen((_, res) => void res.writeHead(301, { location: "http://127.0.0.1:1/elsewhere" }).end());
    const store = new MemoryDeliveryStore();
    const dispatcher = new WebhookDispatcher({ store, endpoints: [{ id: "moved", url, secrets: [SECRET] }], transport: fetchTransport() });
    await dispatcher.publish({ type: "a", payload: {} });
    await dispatcher.tick();
    expect((await store.list({}))[0]!).toMatchObject({ status: "dead", deadReason: "rejected" });
  });
});

describe("httpTransport", () => {
  const request = (url: string) => ({ url, headers: {}, body: "{}", timeoutMs: 1000, now: 0 });

  it("recognizes private and reserved addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "[::1]", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::10.0.0.1"]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ["93.184.215.14", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "example.com"]) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });

  it("refuses private addresses, given literally or through DNS", async () => {
    const url = await listen((_, res) => void res.writeHead(200).end());
    const port = new URL(url).port;
    const send = httpTransport();
    for (const target of [url, `http://localhost:${port}/hooks`, `http://[::ffff:127.0.0.1]:${port}/hooks`]) {
      await expect(send(request(target)), target).rejects.toBeInstanceOf(BlockedAddressError);
    }
  });

  it("reaches private addresses when allowed, and reports status and Retry-After", async () => {
    const url = await listen((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => void res.writeHead(body === "{}" ? 429 : 400, { "retry-after": "7" }).end());
    });
    const res = await httpTransport({ allowPrivateNetworks: true })(request(url));
    expect(res).toMatchObject({ status: 429, headers: { "retry-after": "7" } });
  });

  it("times out a slow receiver", async () => {
    const url = await listen(() => undefined);
    const send = httpTransport({ allowPrivateNetworks: true });
    await expect(send({ ...request(url), timeoutMs: 100 })).rejects.toMatchObject({ name: "TimeoutError" });
    server!.closeAllConnections();
  });

  it("dead-letters a delivery to a blocked address without retrying", async () => {
    const url = await listen((_, res) => void res.writeHead(200).end());
    const store = new MemoryDeliveryStore();
    const dispatcher = new WebhookDispatcher({ store, endpoints: [{ id: "internal", url, secrets: [SECRET] }] });
    await dispatcher.publish({ type: "a", payload: {} });
    await dispatcher.tick();
    const d = (await store.list({}))[0]!;
    expect(d).toMatchObject({ status: "dead", deadReason: "rejected", attempts: 1 });
    expect(d.history[0]).toMatchObject({ status: 0, error: "blocked-address" });
  });
});
