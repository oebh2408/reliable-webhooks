import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReceivedWebhook, WebhookReceiver } from "./receiver.js";
import type { Transport } from "./types.js";

/**
 * Sends requests with the global `fetch` (Node 18+). Redirects are not
 * followed: a 3xx counts as a rejection, so a moved endpoint shows up in the
 * dead letters instead of silently posting somewhere else.
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
