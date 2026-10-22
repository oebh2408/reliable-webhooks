import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { runScenario, type Delivery } from "reliable-webhooks";
import { PostgresDeliveryStore, PostgresIdempotencyStore, SCHEMA, type SqlClient } from "../examples/postgres-store.js";

// PGlite is PostgreSQL compiled to WebAssembly: the real SQL engine, without a server.
async function database(): Promise<SqlClient> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  return {
    async query(text, params) {
      const r = await db.query(text, params);
      return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
    },
  };
}

describe("PostgreSQL stores (example)", () => {
  it("run the full simulated scenario with the same result as the memory stores", async () => {
    const pool = await database();
    const r = await runScenario({
      seed: 4,
      messages: 40,
      workers: 2,
      store: new PostgresDeliveryStore(pool),
      idempotencyStore: (endpointId) => new PostgresIdempotencyStore(pool, endpointId),
    });
    expect(r.exactlyOnce).toBe(true);
    expect(r.deadRemaining).toBe(0);
  }, 60_000);

  it("reject an update based on a stale version", async () => {
    const store = new PostgresDeliveryStore(await database());
    const d: Delivery = {
      id: "m:e", messageId: "m", endpointId: "e", eventType: "a", body: "{}", createdAt: 1, cycleStartedAt: 1,
      status: "pending", attempts: 0, nextAttemptAt: 1, history: [], version: 0,
    };
    expect(await store.insert([d, d])).toBe(1);
    expect(await store.update({ ...d, status: "sending" }, 1)).toBe(true);
    expect(await store.update({ ...d, status: "delivered" }, 1)).toBe(false);
    expect(await store.get("m:e")).toMatchObject({ status: "sending", version: 2 });
  });

  it("claim a received id once, and again only after the lease expires", async () => {
    const store = new PostgresIdempotencyStore(await database());
    expect(await store.claim("msg_1", 0, 1_000)).toBe("claimed");
    expect(await store.claim("msg_1", 500, 1_000)).toBe("in-progress");
    expect(await store.claim("msg_1", 1_000, 1_000)).toBe("claimed");
    await store.complete("msg_1", 1_000, 60_000);
    expect(await store.claim("msg_1", 2_000, 1_000)).toBe("duplicate");
  });
});
