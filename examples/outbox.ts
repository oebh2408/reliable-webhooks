// Publishing in the same transaction as the business change (the transactional outbox).
// If the transaction rolls back, no webhook is sent; if it commits, the webhook will be.
import pg from "pg";
import { WebhookDispatcher } from "reliable-webhooks";
import { PostgresDeliveryStore } from "./postgres-store.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const dispatcher = new WebhookDispatcher({
  store: new PostgresDeliveryStore(pool),
  endpoints: [
    { id: "billing", url: "https://billing.example.com/webhooks", secrets: [process.env.BILLING_SECRET!] },
    { id: "crm", url: "https://crm.example.com/hooks", secrets: [process.env.CRM_SECRET!], eventTypes: ["order.paid"] },
  ],
});

export async function markOrderPaid(orderId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE orders SET status = 'paid' WHERE id = $1", [orderId]);
    const deliveries = await dispatcher.prepare({ type: "order.paid", payload: { orderId }, id: `order-paid-${orderId}` });
    await new PostgresDeliveryStore(client).insert(deliveries);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// In a worker process: send what is due, every second.
dispatcher.onDead((d) => console.error(`webhook ${d.id} dead-lettered: ${d.deadReason}`));
dispatcher.start(1_000);
