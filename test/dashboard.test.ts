import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  createDashboard,
  MemoryDeliveryStore,
  MemoryEndpointStore,
  startPlayground,
  verifyWebhook,
  WebhookDispatcher,
  type OutgoingRequest,
  type Playground,
} from "reliable-webhooks";

let server: Server | undefined;
let playground: Playground | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  await playground?.close();
  playground = undefined;
});

beforeAll(() => {
  // The page is served from the built assets.
  if (!existsSync(new URL("../dashboard/dist/index.html", import.meta.url))) {
    execFileSync("npx", ["vite", "build", "--config", "dashboard/vite.config.ts", "--logLevel", "error"], { stdio: "inherit" });
  }
}, 120_000);

async function setup(token?: string) {
  const sent: OutgoingRequest[] = [];
  const endpoints = new MemoryEndpointStore();
  const dispatcher = new WebhookDispatcher({
    store: new MemoryDeliveryStore(),
    endpoints,
    transport: async (req) => (sent.push(req), { status: req.url.includes("broken") ? 400 : 200 }),
  });
  server = createServer(createDashboard({ dispatcher, endpoints, token }));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data: any = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
    return { status: res.status, body: data };
  };
  return { base, call, dispatcher, endpoints, sent };
}

describe("dashboard API", () => {
  it("serves the page with security headers", async () => {
    const { base } = await setup();
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await res.text()).toContain('content="false"');
  });

  it("creates an endpoint with a generated secret, and lists it without the secret", async () => {
    const { call, endpoints } = await setup();
    const created = await call("POST", "/api/endpoints", { url: "https://billing.example.com/hooks", eventTypes: "order.paid, invoice.issued" });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ id: "billing", eventTypes: ["order.paid", "invoice.issued"] });
    expect(created.body.secrets[0]).toMatch(/^whsec_/);
    expect((await endpoints.get("billing"))!.secrets).toEqual(created.body.secrets);

    const overview = await call("GET", "/api/overview");
    expect(overview.body.endpoints[0]).toMatchObject({ id: "billing", secrets: 1 });
    expect(JSON.stringify(overview.body)).not.toContain("whsec_");
    expect((await call("POST", "/api/endpoints", { url: "https://billing.example.com/other" })).status).toBe(409);
    expect((await call("POST", "/api/endpoints", { url: "javascript:alert(1)" })).status).toBe(400);
  });

  it("rotates secrets without a gap: both are used until the old one is removed", async () => {
    const { call, dispatcher, sent } = await setup();
    const { body: e } = await call("POST", "/api/endpoints", { id: "crm", url: "https://crm.example.com/hooks" });
    const { body: rotated } = await call("POST", "/api/endpoints/crm/secrets", {});
    expect(rotated.secrets).toHaveLength(2);
    expect(rotated.secrets[1]).toBe(e.secrets[0]);

    await call("POST", "/api/endpoints/crm/test", {});
    await dispatcher.tick();
    const req = sent[0]!;
    for (const secret of rotated.secrets) expect(verifyWebhook({ headers: req.headers, body: req.body, secrets: [secret] }).id).toBeTruthy();

    expect((await call("DELETE", "/api/endpoints/crm/secrets/1", {})).body.secrets).toEqual([rotated.secrets[0]]);
    expect((await call("DELETE", "/api/endpoints/crm/secrets/0", {})).status).toBe(400);
  });

  it("publishes events, lists deliveries and redelivers dead letters", async () => {
    const { call, dispatcher } = await setup();
    await call("POST", "/api/endpoints", { id: "ok", url: "https://ok.example.com/" });
    await call("POST", "/api/endpoints", { id: "broken", url: "https://broken.example.com/" });
    const published = await call("POST", "/api/events", { type: "order.paid", payload: { id: 1 } });
    expect(published.body.deliveries).toHaveLength(2);
    await dispatcher.tick();

    const dead = await call("GET", "/api/deliveries?status=dead");
    expect(dead.body.map((d: { endpointId: string }) => d.endpointId)).toEqual(["broken"]);
    expect(dead.body[0].body).toBeUndefined();
    const detail = await call("GET", `/api/deliveries/${encodeURIComponent(dead.body[0].id)}`);
    expect(detail.body.history[0].status).toBe(400);

    expect((await call("POST", `/api/deliveries/${encodeURIComponent(dead.body[0].id)}/redeliver`, {})).body).toEqual({ requeued: 1 });
    expect((await call("GET", "/api/overview")).body.totals).toMatchObject({ delivered: 1, pending: 1, dead: 0 });
  });

  it("pauses an endpoint without using up attempts, and sends after resuming", async () => {
    const { call, dispatcher, sent } = await setup();
    await call("POST", "/api/endpoints", { id: "shop", url: "https://shop.example.com/" });
    await call("PATCH", "/api/endpoints/shop", { paused: true });
    await call("POST", "/api/events", { type: "a", payload: {} });
    expect(await dispatcher.tick()).toMatchObject({ attempted: 0, postponed: 1 });
    await call("PATCH", "/api/endpoints/shop", { paused: false });
    await dispatcher.tick(Date.now() + 11_000);
    expect(sent).toHaveLength(1);
  });

  it("sends test events only to the chosen endpoint, whatever its event types", async () => {
    const { call, dispatcher, sent } = await setup();
    await call("POST", "/api/endpoints", { id: "a", url: "https://a.example.com/", eventTypes: ["order.paid"] });
    await call("POST", "/api/endpoints", { id: "b", url: "https://b.example.com/" });
    await call("POST", "/api/endpoints/a/test", {});
    await dispatcher.tick();
    expect(sent.map((r) => r.url)).toEqual(["https://a.example.com/"]);
    expect(JSON.parse(sent[0]!.body).type).toBe("webhook.test");
  });

  it("requires the token when one is set", async () => {
    const { base, call } = await setup("s3cret-token");
    expect((await call("GET", "/api/overview")).status).toBe(200);
    expect((await fetch(base + "/api/overview")).status).toBe(401);
    expect((await fetch(base + "/api/overview", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect(await (await fetch(base + "/")).text()).toContain('content="true"');
  });

  it("refuses writes that are not JSON, which blocks cross-site form posts", async () => {
    const { base } = await setup();
    const res = await fetch(base + "/api/events", { method: "POST", headers: { "content-type": "text/plain" }, body: '{"type":"x"}' });
    expect(res.status).toBe(415);
  });
});

describe("playground", () => {
  it("delivers random traffic to its local receivers", async () => {
    playground = await startPlayground({ port: 0 });
    let delivered = 0;
    for (let i = 0; i < 40 && delivered === 0; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const overview: any = await (await fetch(`${playground.url}/api/overview`)).json();
      delivered = overview.totals.delivered;
    }
    expect(delivered).toBeGreaterThan(0);
    const state: any = await (await fetch(`${playground.url}/api/playground`)).json();
    expect(state.receivers.find((r: { endpointId: string }) => r.endpointId === "orders").processed).toBeGreaterThan(0);
  }, 20_000);
});
