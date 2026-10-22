import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { BlockedAddressError, guardedLookup, isPrivateAddress } from "./network.js";
import type { ReceivedWebhook, WebhookReceiver } from "./receiver.js";
import type { Transport } from "./types.js";

export interface HttpTransportOptions {
  /**
   * Allow endpoints on loopback, private and link-local addresses. Off by
   * default, so an endpoint URL entered by a user cannot be used to reach
   * internal services. Turn it on when every endpoint is your own.
   */
  allowPrivateNetworks?: boolean;
  /** Extra options for `https.request`, for example a custom CA. */
  tls?: https.RequestOptions;
}

/**
 * The default transport, on `node:http` and `node:https`. Redirects are not
 * followed (a 3xx is a rejection). Unless `allowPrivateNetworks` is set, it
 * refuses to connect to private or reserved addresses, checking the address
 * actually used for the connection.
 */
export function httpTransport(options: HttpTransportOptions = {}): Transport {
  return (req) =>
    new Promise((resolve, reject) => {
      const url = new URL(req.url);
      const client = url.protocol === "https:" ? https : url.protocol === "http:" ? http : undefined;
      if (!client) return reject(new Error(`unsupported protocol ${url.protocol}`));
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (!options.allowPrivateNetworks && isIP(host) && isPrivateAddress(host)) {
        return reject(new BlockedAddressError(host, host));
      }
      const started = Date.now();
      const request = client.request(url, {
        ...options.tls,
        method: "POST",
        headers: { ...req.headers, "content-length": String(Buffer.byteLength(req.body)) },
        lookup: options.allowPrivateNetworks ? undefined : (guardedLookup as never),
      });
      const timer = setTimeout(
        () => request.destroy(Object.assign(new Error("request timed out"), { name: "TimeoutError" })),
        req.timeoutMs,
      );
      request.on("response", (res) => {
        clearTimeout(timer);
        // The response body is not used; drain it so the connection can be reused.
        res.resume();
        const retryAfter = res.headers["retry-after"];
        resolve({ status: res.statusCode ?? 0, headers: { "retry-after": Array.isArray(retryAfter) ? retryAfter[0] : retryAfter }, durationMs: Date.now() - started });
      });
      request.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      request.end(req.body);
    });
}

/**
 * Sends requests with the global `fetch` (Node 18+), or one you pass.
 * Redirects are not followed. Unlike {@link httpTransport} it does not block
 * private addresses; use it for runtimes without `node:http`, or to plug in
 * a custom fetch.
 */
export function fetchTransport(options: { fetch?: typeof fetch } = {}): Transport {
  const doFetch = options.fetch ?? fetch;
  return async (req) => {
    const started = Date.now();
    const res = await doFetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      redirect: "manual",
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    // The response body is not used; release the connection.
    await res.body?.cancel().catch(() => undefined);
    return {
      status: res.status,
      headers: { "retry-after": res.headers.get("retry-after") ?? undefined },
      durationMs: Date.now() - started,
    };
  };
}

/** Reads the raw body of a Node request. Signatures are checked against these exact bytes. */
export async function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A `node:http` request handler around a {@link WebhookReceiver}. Also works
 * as Express middleware, as long as no body parser ran before it.
 */
export function nodeHandler(
  receiver: WebhookReceiver,
  handler: (event: ReceivedWebhook) => unknown | Promise<unknown>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413).end();
      return;
    }
    const result = await receiver.handle({ headers: req.headers, body }, handler);
    res.writeHead(result.status, { "content-type": "application/json", ...result.headers });
    res.end(JSON.stringify({ outcome: result.outcome }));
  };
}
