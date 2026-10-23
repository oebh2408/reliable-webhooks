import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createDashboard } from "./dashboard.js";
import { WebhookDispatcher } from "./dispatcher.js";
import { MemoryEndpointStore } from "./endpoints.js";
import { httpTransport, readBody } from "./http.js";
import { MemoryIdempotencyStore, WebhookReceiver } from "./receiver.js";
import { generateKeyPair, generateSecret, isSecretKey, publicKeyFor } from "./signature.js";
import { MemoryDeliveryStore } from "./store.js";
import type { Endpoint } from "./types.js";

export interface PlaygroundOptions {
  /** Dashboard port. Default 4000. */
  port?: number;
  /** Interface to listen on. Default 127.0.0.1. */
  host?: string;
  /** Start with random traffic on. Default true. */
  traffic?: boolean;
}

export interface Playground {
  url: string;
  close(): Promise<void>;
}

interface LocalReceiver {
  endpointId: string;
  behaviour: string;
  idempotency: MemoryIdempotencyStore;
  processed: number;
  duplicates: number;
  rejected: number;
}

const EVENT_TYPES = ["order.created", "order.paid", "order.shipped", "invoice.issued"];

/**
 * Runs the dashboard with everything in memory and a second local server that
 * plays five receivers with different failures. Used by `npm run dashboard`.
 */
export async function startPlayground(options: PlaygroundOptions = {}): Promise<Playground> {
  const host = options.host ?? "127.0.0.1";
  const flags = { traffic: options.traffic ?? true, analyticsDown: false, legacyFixed: false };
  const receivers = new Map<string, LocalReceiver>();
  const behaviours: Record<string, string> = {
    orders: "Healthy. Signs with an ed25519 key; events of one order arrive in order",
    crm: "20% of requests fail with 503",
    analytics: "Drops connections while it is down",
    partner: "Slow: 20% of requests take longer than the 2 s timeout",
    legacy: "Its receiver has a stale secret until fixed",
  };
  for (const [endpointId, behaviour] of Object.entries(behaviours)) {
    receivers.set(endpointId, { endpointId, behaviour, idempotency: new MemoryIdempotencyStore(), processed: 0, duplicates: 0, rejected: 0 });
  }

  const endpoints = new MemoryEndpointStore();
  const staleSecret = generateSecret();

  // The receivers: one local server, one path per endpoint.
  const receiverServer = createServer((req, res) => {
    receive(req, res).catch(() => {
      // The dispatcher gave up on the request (timeout) and closed the connection.
      if (!res.headersSent) res.destroy();
    });
  });
  async function receive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const endpointId = req.url?.split("/")[1] ?? "";
    const r = receivers.get(endpointId);
    const endpoint = await endpoints.get(endpointId);
    if (!r || req.method !== "POST") return void res.writeHead(404).end();
    if (endpointId === "analytics" && flags.analyticsDown) return void req.socket.destroy();
    if (endpointId === "crm" && Math.random() < 0.2) return void res.writeHead(503).end();
    if (endpointId === "partner" && Math.random() < 0.2) await new Promise((ok) => setTimeout(ok, 2_500));
    // A receiver holds the HMAC secrets, and only the public key of an ed25519 one.
    const current = (endpoint?.secrets ?? []).map((s) => (isSecretKey(s) ? publicKeyFor(s) : s));
    const secrets = endpointId === "legacy" && !flags.legacyFixed ? [staleSecret] : current;
    const body = await readBody(req);
    const result = await new WebhookReceiver({ secrets, store: r.idempotency }).handle({ headers: req.headers, body }, () => {
      r.processed++;
    });
    if (result.outcome === "duplicate") r.duplicates++;
    if (result.status === 401) r.rejected++;
    if (!res.destroyed) res.writeHead(result.status, result.headers).end();
  }
  const receiverUrl = await listen(receiverServer, host, 0);

  for (const id of Object.keys(behaviours)) {
    const endpoint: Endpoint = {
      id,
      url: `${receiverUrl}/${id}`,
      secrets: [id === "orders" ? generateKeyPair().secretKey : generateSecret()],
      description: behaviours[id],
      eventTypes: id === "legacy" ? ["invoice.issued"] : id === "partner" ? ["order.paid", "order.shipped"] : undefined,
    };
    await endpoints.save(endpoint);
  }

  const dispatcher = new WebhookDispatcher({
    store: new MemoryDeliveryStore(),
    endpoints,
    // The playground's receivers are on localhost.
    transport: httpTransport({ allowPrivateNetworks: true }),
    timeoutMs: 2_000,
    leaseMs: 10_000,
    // Shorter than the defaults, so that retries are visible while watching.
    retry: { baseDelayMs: 2_000, factor: 3, maxDelayMs: 10 * 60_000 },
    breaker: { failureThreshold: 4, cooldownMs: 15_000, maxCooldownMs: 2 * 60_000 },
    retention: { deliveredMs: 30 * 60_000, deadMs: 2 * 60 * 60_000 },
  });
  const stopDispatcher = dispatcher.start(500);

  let n = 0;
  const traffic = setInterval(() => {
    if (!flags.traffic) return;
    const type = EVENT_TYPES[Math.floor(Math.random() * EVENT_TYPES.length)]!;
    // Order events pick one of a few open orders, and keep their order per order id.
    const orderId = `order_${1000 + Math.floor(Math.random() * 5)}`;
    const id = type.startsWith("order.") ? orderId : `invoice_${1000 + ++n}`;
    const orderingKey = type.startsWith("order.") ? orderId : undefined;
    void dispatcher.publish({ type, payload: { id, amount: Math.round(Math.random() * 50_000) / 100 }, orderingKey });
  }, 1_500);

  const dashboard = createDashboard({ dispatcher, endpoints });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith("/api/playground")) {
      if (req.method === "POST") {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse((await readBody(req)) || "{}");
        } catch {
          return void res.writeHead(400).end();
        }
        for (const key of ["traffic", "analyticsDown", "legacyFixed"] as const) {
          if (typeof input[key] === "boolean") flags[key] = input[key];
        }
      }
      const state = {
        ...flags,
        receivers: [...receivers.values()].map(({ idempotency: _, ...r }) => r),
      };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state));
      return;
    }
    await dashboard(req, res);
  });
  const url = await listen(server, host, options.port ?? 4000);

  return {
    url,
    async close() {
      clearInterval(traffic);
      stopDispatcher();
      server.closeAllConnections();
      receiverServer.closeAllConnections();
      await Promise.all([new Promise((ok) => server.close(ok)), new Promise((ok) => receiverServer.close(ok))]);
    },
  };
}

async function listen(server: Server, host: string, port: number): Promise<string> {
  await new Promise<void>((ok, fail) => server.once("error", fail).listen(port, host, ok));
  const address = server.address() as AddressInfo;
  return `http://${host}:${address.port}`;
}
