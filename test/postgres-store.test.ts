import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { generateSecret, runScenario, WebhookDispatcher, type Delivery } from "reliable-webhooks";
import { PostgresDeliveryStore, PostgresEndpointStore, PostgresIdempotencyStore, SCHEMA, type SqlClient } from "../examples/postgres-store.js";

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

  it("count deliveries and list them newest first", async () => {
    const store = new PostgresDeliveryStore(await database());
    const base = { eventType: "a", body: "{}", status: "pending" as const, attempts: 0, history: [], version: 0 };
    await store.insert([
      { ...base, id: "m1:a", messageId: "m1", endpointId: "a", createdAt: 1, cycleStartedAt: 1, nextAttemptAt: 1 },
      { ...base, id: "m2:a", messageId: "m2", endpointId: "a", createdAt: 2, cycleStartedAt: 2, nextAttemptAt: 2 },
      { ...base, id: "m2:b", messageId: "m2", endpointId: "b", createdAt: 2, cycleStartedAt: 2, nextAttemptAt: 2 },
    ]);
    expect((await store.counts()).sort((x, y) => x.endpointId.localeCompare(y.endpointId))).toEqual([
      { endpointId: "a", status: "pending", count: 2 },
      { endpointId: "b", status: "pending", count: 1 },
    ]);
    expect((await store.list({ endpointId: "a", order: "desc" })).map((d) => d.id)).toEqual(["m2:a", "m1:a"]);
  });

  it("store endpoints", async () => {
    const store = new PostgresEndpointStore(await database());
    await store.save({ id: "crm", url: "https://crm.example.com", secrets: ["s1"] });
    await store.save({ id: "crm", url: "https://crm.example.com", secrets: ["s2", "s1"], paused: true });
    expect(await store.list()).toEqual([{ id: "crm", url: "https://crm.example.com", secrets: ["s2", "s1"], paused: true }]);
    expect(await store.delete("crm")).toBe(true);
    expect(await store.get("crm")).toBeUndefined();
  });

  it("keep ordering keys in order and purge finished rows", async () => {
    const store = new PostgresDeliveryStore(await database());
    const seen: number[] = [];
    let calls = 0;
    const dispatcher = new WebhookDispatcher({
      store,
      endpoints: [{ id: "e", url: "https://e.example.test/", secrets: [generateSecret()], maxConcurrency: 3 }],
      transport: async (req) => {
        // The first request fails, so the next two events of the key wait for its retry.
        if (++calls === 1) return { status: 503 };
        seen.push(JSON.parse(req.body).data.i);
        return { status: 200 };
      },
      random: () => 0,
    });
    for (let i = 0; i < 3; i++) await dispatcher.publish({ type: "a", payload: { i }, orderingKey: "k" }, 1_000);
    await dispatcher.tick(1_000);
    expect(seen).toEqual([]);
    for (let t = 6_000; seen.length < 3 && t < 30_000; t += 1_000) await dispatcher.tick(t);
    expect(seen).toEqual([0, 1, 2]);
    expect(await dispatcher.purge({ deliveredMs: 0 }, 60_000)).toEqual({ delivered: 3, dead: 0 });
    expect(await store.counts()).toEqual([]);
  });
});
