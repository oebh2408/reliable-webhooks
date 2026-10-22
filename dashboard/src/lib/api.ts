import type { Attempt, Delivery, DeliveryStatus, Endpoint, EndpointState } from "../../../src/types.js";

export type { Attempt, Delivery, DeliveryStatus, Endpoint, EndpointState };

export type Counts = Record<DeliveryStatus, number>;

export interface EndpointRow extends Omit<Endpoint, "secrets"> {
  secrets: number;
  state: EndpointState | null;
  counts: Counts;
  lastAttempt: Attempt | null;
}

export interface Overview {
  now: number;
  totals: Counts;
  endpoints: EndpointRow[];
}

export type DeliverySummary = Omit<Delivery, "body" | "history"> & { lastAttempt: Attempt | null };

export interface PlaygroundState {
  traffic: boolean;
  analyticsDown: boolean;
  legacyFixed: boolean;
  receivers: { endpointId: string; behaviour: string; processed: number; duplicates: number; rejected: number }[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = "reliable-webhooks-token";

export const tokenRequired = document.querySelector<HTMLMetaElement>('meta[name="rw-token-required"]')?.content === "true";

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable: the token lasts until reload.
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`./api/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  overview: () => request<Overview>("GET", "overview"),
  endpoint: (id: string) => request<Endpoint & { state: EndpointState | null }>("GET", `endpoints/${enc(id)}`),
  createEndpoint: (input: { id?: string; url: string; description?: string; eventTypes?: string[] }) =>
    request<Endpoint>("POST", "endpoints", input),
  updateEndpoint: (id: string, input: Partial<Pick<Endpoint, "url" | "description" | "eventTypes" | "paused">>) =>
    request<Endpoint>("PATCH", `endpoints/${enc(id)}`, input),
  deleteEndpoint: (id: string) => request<{ deleted: boolean }>("DELETE", `endpoints/${enc(id)}`, {}),
  rotateSecret: (id: string) => request<Endpoint>("POST", `endpoints/${enc(id)}/secrets`, {}),
  removeSecret: (id: string, index: number) => request<Endpoint>("DELETE", `endpoints/${enc(id)}/secrets/${index}`, {}),
  enable: (id: string) => request<object>("POST", `endpoints/${enc(id)}/enable`, {}),
  sendTest: (id: string) => request<{ messageId: string }>("POST", `endpoints/${enc(id)}/test`, {}),
  redeliverEndpoint: (id: string) => request<{ requeued: number }>("POST", `endpoints/${enc(id)}/redeliver`, {}),
  deliveries: (query: { status?: string; endpointId?: string; messageId?: string; limit?: number }) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") params.set(k, String(v));
    return request<DeliverySummary[]>("GET", `deliveries?${params}`);
  },
  delivery: (id: string) => request<Delivery>("GET", `deliveries/${enc(id)}`),
  redeliver: (id: string) => request<{ requeued: number }>("POST", `deliveries/${enc(id)}/redeliver`, {}),
  publish: (input: { type: string; payload: unknown; endpointIds?: string[] }) =>
    request<{ messageId: string; deliveries: string[] }>("POST", "events", input),
  playground: () => request<PlaygroundState>("GET", "playground"),
  setPlayground: (input: Partial<Pick<PlaygroundState, "traffic" | "analyticsDown" | "legacyFixed">>) =>
    request<PlaygroundState>("POST", "playground", input),
};
