import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { WebhookDispatcher } from "./dispatcher.js";
import type { EndpointStore } from "./endpoints.js";
import { readBody } from "./http.js";
import { generateKeyPair, generateSecret, isSecretKey, publicKeyFor } from "./signature.js";
import type { Attempt, Delivery, DeliveryStatus, Endpoint } from "./types.js";

export interface DashboardOptions {
  dispatcher: WebhookDispatcher;
  /** Must be the same store the dispatcher reads its endpoints from. */
  endpoints: EndpointStore;
  /**
   * When set, every API request needs `Authorization: Bearer <token>`; the
   * page asks for it once per browser tab. Leave it unset only when the
   * dashboard is reachable from localhost alone.
   */
  token?: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const STATUSES: DeliveryStatus[] = ["pending", "sending", "delivered", "dead"];
/** The built page (`npm run build:dashboard`), next to `dist/` and `src/`. */
const ASSETS = new URL("../dashboard/dist/", import.meta.url);
const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function asset(name: string): Buffer | undefined {
  const file = new URL(name, ASSETS);
  return existsSync(file) ? readFileSync(file) : undefined;
}

/**
 * A `node:http` handler that serves the dashboard page and its JSON API.
 * Mount it on its own server or under a path of an existing one (the page
 * uses relative URLs).
 */
export function createDashboard(options: DashboardOptions): Handler {
  const { dispatcher, endpoints, token } = options;
  const store = dispatcher.store;

  const routes: [string, RegExp, (m: string[], body: any, url: URL) => Promise<unknown>][] = [
    ["GET", /^\/api\/overview$/, () => overview()],
    ["GET", /^\/api\/endpoints$/, async () => (await endpoints.list()).map(mask)],
    ["POST", /^\/api\/endpoints$/, (_, body) => createEndpoint(body)],
    ["GET", /^\/api\/endpoints\/([^/]+)$/, ([id]) => endpointDetail(id!)],
    ["PATCH", /^\/api\/endpoints\/([^/]+)$/, ([id], body) => updateEndpoint(id!, body)],
    ["DELETE", /^\/api\/endpoints\/([^/]+)$/, async ([id]) => ({ deleted: await endpoints.delete(id!) })],
    ["POST", /^\/api\/endpoints\/([^/]+)\/secrets$/, ([id], body) => rotate(id!, body)],
    ["DELETE", /^\/api\/endpoints\/([^/]+)\/secrets\/(\d+)$/, ([id, n]) => removeSecret(id!, Number(n))],
    ["POST", /^\/api\/endpoints\/([^/]+)\/enable$/, async ([id]) => (await mustGet(id!), await dispatcher.enableEndpoint(id!), {})],
    ["POST", /^\/api\/endpoints\/([^/]+)\/test$/, ([id], body) => sendTest(id!, body)],
    ["POST", /^\/api\/endpoints\/([^/]+)\/redeliver$/, async ([id]) => ({ requeued: await dispatcher.redeliver({ endpointId: id }) })],
    ["GET", /^\/api\/deliveries$/, (_, __, url) => deliveries(url)],
    ["GET", /^\/api\/deliveries\/([^/]+)$/, ([id]) => delivery(id!)],
    ["POST", /^\/api\/deliveries\/([^/]+)\/redeliver$/, async ([id]) => ({ requeued: await dispatcher.redeliver({ ids: [id!] }) })],
    ["POST", /^\/api\/events$/, (_, body) => publish(body)],
  ];

  async function mustGet(id: string): Promise<Endpoint> {
    const e = await endpoints.get(id);
    if (!e) throw new HttpError(404, `no endpoint "${id}"`);
    return e;
  }

  async function overview() {
    const [list, counts] = await Promise.all([endpoints.list(), store.counts()]);
    const totals = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<DeliveryStatus, number>;
    for (const c of counts) totals[c.status] += c.count;
    const metrics = new Map(dispatcher.metrics.snapshot().map((m) => [m.endpointId, m]));
    const rows = await Promise.all(
      list.map(async (e) => {
        const [state, recent] = await Promise.all([store.getEndpointState(e.id), store.list({ endpointId: e.id, order: "desc", limit: 20 })]);
        const lastAttempt = recent.flatMap((d) => d.history).reduce<Attempt | null>((a, b) => (!a || b.at > a.at ? b : a), null);
        const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<DeliveryStatus, number>;
        for (const c of counts) if (c.endpointId === e.id) byStatus[c.status] += c.count;
        return { ...mask(e), state: state ?? null, counts: byStatus, lastAttempt, metrics: metrics.get(e.id) ?? null };
      }),
    );
    return { now: Date.now(), totals, endpoints: rows.sort((a, b) => a.id.localeCompare(b.id)) };
  }

  async function endpointDetail(id: string) {
    const e = await mustGet(id);
    return { ...withKeys(e), state: (await store.getEndpointState(id)) ?? null };
  }

  async function createEndpoint(body: any) {
    const url = validUrl(body?.url);
    const id = slug(String(body?.id || new URL(url).hostname.split(".")[0] || "endpoint"));
    if (await endpoints.get(id)) throw new HttpError(409, `an endpoint "${id}" already exists`);
    const endpoint: Endpoint = { id, url, secrets: [generateSecret()], ...fields(body) };
    await endpoints.save(endpoint);
    return endpoint;
  }

  async function updateEndpoint(id: string, body: any) {
    const e = await mustGet(id);
    const next: Endpoint = { ...e, ...fields(body) };
    if (body?.url !== undefined) next.url = validUrl(body.url);
    if (body?.paused !== undefined) next.paused = Boolean(body.paused);
    await endpoints.save(next);
    return next;
  }

  async function rotate(id: string, body: any) {
    const e = await mustGet(id);
    const secret = body?.kind === "ed25519" ? generateKeyPair().secretKey : generateSecret();
    const next = { ...e, secrets: [secret, ...e.secrets] };
    await endpoints.save(next);
    return withKeys(next);
  }

  async function removeSecret(id: string, n: number) {
    const e = await mustGet(id);
    if (e.secrets.length < 2) throw new HttpError(400, "an endpoint needs at least one secret");
    if (n < 0 || n >= e.secrets.length) throw new HttpError(404, "no such secret");
    const next = { ...e, secrets: e.secrets.filter((_, i) => i !== n) };
    await endpoints.save(next);
    return withKeys(next);
  }

  async function sendTest(id: string, body: any) {
    await mustGet(id);
    const type = typeof body?.type === "string" && body.type ? body.type : "webhook.test";
    return dispatcher.publish({ type, payload: { message: "Test event sent from the dashboard" }, endpointIds: [id] });
  }

  async function publish(body: any) {
    if (typeof body?.type !== "string" || !body.type.trim()) throw new HttpError(400, "type is required");
    const endpointIds = Array.isArray(body.endpointIds) && body.endpointIds.length ? body.endpointIds.map(String) : undefined;
    const orderingKey = typeof body.orderingKey === "string" && body.orderingKey.trim() ? body.orderingKey.trim().slice(0, 200) : undefined;
    return dispatcher.publish({ type: body.type.trim(), payload: body.payload ?? {}, endpointIds, orderingKey });
  }

  async function deliveries(url: URL) {
    const status = url.searchParams.get("status") as DeliveryStatus | null;
    if (status && !STATUSES.includes(status)) throw new HttpError(400, "unknown status");
    const list = await store.list({
      status: status ?? undefined,
      endpointId: url.searchParams.get("endpointId") ?? undefined,
      messageId: url.searchParams.get("messageId") ?? undefined,
      limit: Math.min(500, Number(url.searchParams.get("limit")) || 100),
      order: "desc",
    });
    return list.map(summary);
  }

  async function delivery(id: string) {
    const d = await store.get(id);
    if (!d) throw new HttpError(404, "no such delivery");
    return d;
  }

  const authorized = (req: IncomingMessage): boolean => {
    if (!token) return true;
    const given = Buffer.from(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://dashboard.local");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (req.method === "GET" && !path.includes("/api/")) {
        const file = path.match(/\/assets\/([\w.-]+)$/)?.[1];
        if (file) {
          const content = asset(`assets/${file}`);
          if (!content) throw new HttpError(404, "not found");
          res.writeHead(200, {
            "content-type": TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
            "cache-control": "public, max-age=31536000, immutable",
            ...SECURITY_HEADERS,
          });
          res.end(content);
          return;
        }
        const html = asset("index.html");
        if (!html) throw new HttpError(500, "dashboard not built: run npm run build:dashboard");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS });
        res.end(html.toString("utf8").replace("__TOKEN_REQUIRED__", token ? "true" : "false"));
        return;
      }
      const api = path.match(/\/api\/.*$/)?.[0];
      if (!api) throw new HttpError(404, "not found");
      if (!authorized(req)) throw new HttpError(401, "missing or wrong token");
      if (!token && !isLocalHost(req.headers.host)) {
        // Without a token, only answer requests addressed to localhost. This stops DNS rebinding:
        // a page on another domain that resolves to 127.0.0.1 still sends its own host name.
        throw new HttpError(403, "without a token, the dashboard API only answers on localhost");
      }
      if (req.method === "GET" && api === "/api/metrics") {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
        res.end(await dispatcher.prometheus());
        return;
      }
      if (req.method === "POST") {
        // A JSON content type cannot be sent cross-site without a CORS preflight, which this server never approves.
        // PATCH and DELETE always need a preflight.
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          throw new HttpError(415, "send JSON with content-type: application/json");
        }
      }
      for (const [method, pattern, run] of routes) {
        if (method !== req.method) continue;
        const m = api.match(pattern);
        if (!m) continue;
        const raw = req.method === "GET" ? "" : await readBody(req, 256 * 1024);
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          throw new HttpError(400, "body is not valid JSON");
        }
        const result = await run(m.slice(1).map(decodeURIComponent), body, url);
        return json(res, 200, result);
      }
      throw new HttpError(404, "not found");
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      return json(res, 500, { error: "internal error" });
    }
  };
}

function isLocalHost(host: string | undefined): boolean {
  const name = (host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

/** Overview and lists never include secrets; the endpoint detail does. */
function mask(e: Endpoint): Omit<Endpoint, "secrets"> & { secrets: number } {
  return { ...e, secrets: e.secrets.length };
}

/** The endpoint with the public key of each ed25519 secret, which is what receivers need. */
function withKeys(e: Endpoint) {
  return { ...e, publicKeys: e.secrets.map((s) => (isSecretKey(s) ? publicKeyFor(s) : null)) };
}

function summary(d: Delivery) {
  const { body, history, ...rest } = d;
  return { ...rest, lastAttempt: history.at(-1) ?? null };
}

function fields(body: any): Partial<Endpoint> {
  const out: Partial<Endpoint> = {};
  if (typeof body?.description === "string") out.description = body.description.slice(0, 200);
  if (body?.eventTypes !== undefined) {
    const types = (Array.isArray(body.eventTypes) ? body.eventTypes : String(body.eventTypes).split(","))
      .map((t: unknown) => String(t).trim())
      .filter(Boolean);
    out.eventTypes = types.length ? types : undefined;
  }
  out.rateLimit = limit(body, "rateLimit", 0.01, 10_000, false);
  out.maxConcurrency = limit(body, "maxConcurrency", 1, 50, true);
  out.timeoutMs = limit(body, "timeoutMs", 100, 120_000, true);
  for (const key of ["rateLimit", "maxConcurrency", "timeoutMs"] as const) if (typeof body !== "object" || !body || !(key in body)) delete out[key];
  return out;
}

/** A numeric endpoint limit: null or "" clears it, anything else must be in range. */
function limit(body: any, key: string, min: number, max: number, integer: boolean): number | undefined {
  const value = body?.[key];
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new HttpError(400, `${key} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}`);
  }
  return n;
}

function validUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
  } catch {
    // fall through
  }
  throw new HttpError(400, "url must be an http or https URL");
}

function slug(value: string): string {
  const s = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!s) throw new HttpError(400, "invalid id");
  return s;
}
