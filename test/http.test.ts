import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchTransport, MemoryDeliveryStore, nodeHandler, WebhookDispatcher, WebhookReceiver } from "reliable-webhooks";

const SECRET = "whsec_dGVzdC1zZWNyZXQtMDEyMzQ1Njc4OQ==";
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
