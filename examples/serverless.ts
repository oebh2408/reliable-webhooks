// The dispatcher in serverless functions: one function publishes, a scheduled one sends.
// Several instances may run at once; leases and conditional updates keep them apart.
import pg from "pg";
import { WebhookDispatcher } from "reliable-webhooks";
import { PostgresDeliveryStore } from "./postgres-store.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

const dispatcher = new WebhookDispatcher({
  store: new PostgresDeliveryStore(pool),
  endpoints: JSON.parse(process.env.WEBHOOK_ENDPOINTS ?? "[]"),
  timeoutMs: 10_000,
  leaseMs: 60_000,
});

// Called by your API when something happens.
export async function onOrderPaid(input: { orderId: string }) {
  return dispatcher.publish({ type: "order.paid", payload: input, id: `order-paid-${input.orderId}` });
}

// Called by a scheduler every few seconds. Sends at most 200 deliveries per run.
export async function onSchedule() {
  return dispatcher.tick(undefined, 200);
}
