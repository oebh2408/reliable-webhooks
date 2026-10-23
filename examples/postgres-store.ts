import type {
  ClaimResult,
  Delivery,
  DeliveryCount,
  DeliveryQuery,
  DeliveryStore,
  Endpoint,
  EndpointState,
  EndpointStore,
  IdempotencyStore,
} from "reliable-webhooks";

/** The subset of a PostgreSQL client these stores need. A node-postgres `Pool` fits as is. */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id              TEXT PRIMARY KEY,
    message_id      TEXT    NOT NULL,
    endpoint_id     TEXT    NOT NULL,
    status          TEXT    NOT NULL,
    next_attempt_at BIGINT  NOT NULL,
    created_at      BIGINT  NOT NULL,
    version         INTEGER NOT NULL,
    data            JSONB   NOT NULL
  );
  CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id, status);

  -- Added in 0.4.0: ordering keys and purging finished rows.
  ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS ordering_key TEXT;
  ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS sequence BIGINT;
  ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS finished_at BIGINT;
  CREATE INDEX IF NOT EXISTS webhook_deliveries_ordering ON webhook_deliveries (endpoint_id, ordering_key, sequence)
    WHERE ordering_key IS NOT NULL AND status IN ('pending', 'sending');
  CREATE INDEX IF NOT EXISTS webhook_deliveries_finished ON webhook_deliveries (status, finished_at)
    WHERE finished_at IS NOT NULL;

  CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id   TEXT PRIMARY KEY,
    data JSONB NOT NULL
  );

  CREATE TABLE IF NOT EXISTS webhook_endpoint_state (
    endpoint_id TEXT PRIMARY KEY,
    data        JSONB NOT NULL
  );

  CREATE TABLE IF NOT EXISTS webhook_received (
    scope      TEXT    NOT NULL,
    message_id TEXT    NOT NULL,
    done       BOOLEAN NOT NULL,
    until      BIGINT  NOT NULL,
    PRIMARY KEY (scope, message_id)
  );
`;

const parse = (row: any): Delivery => ({
  ...(typeof row.data === "string" ? JSON.parse(row.data) : row.data),
  version: Number(row.version),
});

/**
 * The outbox as one table. Status, due time and version are real columns so
 * they can be indexed and used in the conditional update; the rest of the
 * delivery is JSON.
 *
 * To publish in the same transaction as your business change, run the
 * `insert` on the transaction's client.
 */
export class PostgresDeliveryStore implements DeliveryStore {
  constructor(private readonly db: SqlClient) {}

  async insert(deliveries: Delivery[]): Promise<number> {
    let inserted = 0;
    for (const d of deliveries) {
      const { rows } = await this.db.query(
        `INSERT INTO webhook_deliveries
           (id, message_id, endpoint_id, status, next_attempt_at, created_at, ordering_key, sequence, version, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [
          d.id,
          d.messageId,
          d.endpointId,
          d.status,
          d.nextAttemptAt,
          d.createdAt,
          d.orderingKey ?? null,
          d.sequence ?? null,
          JSON.stringify({ ...d, version: undefined }),
        ],
      );
      inserted += rows.length;
    }
    return inserted;
  }

  async get(id: string): Promise<Delivery | undefined> {
    const { rows } = await this.db.query("SELECT data, version FROM webhook_deliveries WHERE id = $1", [id]);
    return rows.length ? parse(rows[0]) : undefined;
  }

  async due(now: number, limit: number): Promise<Delivery[]> {
    const { rows } = await this.db.query(
      `SELECT data, version FROM webhook_deliveries
       WHERE status IN ('pending', 'sending') AND next_attempt_at <= $1
       ORDER BY next_attempt_at LIMIT $2`,
      [now, limit],
    );
    return rows.map(parse);
  }

  async update(d: Delivery, expectedVersion: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE webhook_deliveries SET status = $1, next_attempt_at = $2, finished_at = $3, version = version + 1, data = $4
       WHERE id = $5 AND version = $6`,
      [d.status, d.nextAttemptAt, d.deliveredAt ?? d.deadAt ?? null, JSON.stringify({ ...d, version: undefined }), d.id, expectedVersion],
    );
    return rowCount === 1;
  }

  async list(query: DeliveryQuery): Promise<Delivery[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of [
      ["status", query.status],
      ["endpoint_id", query.endpointId],
      ["message_id", query.messageId],
    ] as const) {
      if (value === undefined) continue;
      params.push(value);
      where.push(`${column} = $${params.length}`);
    }
    params.push(query.limit ?? 1000);
    const { rows } = await this.db.query(
      `SELECT data, version FROM webhook_deliveries ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at ${query.order === "desc" ? "DESC" : "ASC"}, id LIMIT $${params.length}`,
      params,
    );
    return rows.map(parse);
  }

  async head(endpointId: string, orderingKey: string): Promise<Delivery | undefined> {
    const { rows } = await this.db.query(
      `SELECT data, version FROM webhook_deliveries
       WHERE endpoint_id = $1 AND ordering_key = $2 AND status IN ('pending', 'sending')
       ORDER BY sequence LIMIT 1`,
      [endpointId, orderingKey],
    );
    return rows.length ? parse(rows[0]) : undefined;
  }

  async purge(status: "delivered" | "dead", before: number, limit: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM webhook_deliveries WHERE id IN (
         SELECT id FROM webhook_deliveries WHERE status = $1 AND finished_at < $2 LIMIT $3
       )`,
      [status, before, limit],
    );
    return rowCount ?? 0;
  }

  async counts(): Promise<DeliveryCount[]> {
    const { rows } = await this.db.query(
      "SELECT endpoint_id, status, COUNT(*) AS count FROM webhook_deliveries GROUP BY endpoint_id, status",
    );
    return rows.map((r) => ({ endpointId: r.endpoint_id, status: r.status, count: Number(r.count) }));
  }

  async getEndpointState(endpointId: string): Promise<EndpointState | undefined> {
    const { rows } = await this.db.query("SELECT data FROM webhook_endpoint_state WHERE endpoint_id = $1", [endpointId]);
    if (!rows.length) return undefined;
    return typeof rows[0].data === "string" ? JSON.parse(rows[0].data) : rows[0].data;
  }

  async saveEndpointState(state: EndpointState): Promise<void> {
    await this.db.query(
      `INSERT INTO webhook_endpoint_state (endpoint_id, data) VALUES ($1, $2)
       ON CONFLICT (endpoint_id) DO UPDATE SET data = EXCLUDED.data`,
      [state.endpointId, JSON.stringify(state)],
    );
  }
}

/**
 * Receiver-side idempotency. The claim is one atomic statement: insert the
 * id, or take over a row whose lease or retention has expired. A returned row
 * means this caller owns the message.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly db: SqlClient,
    private readonly scope = "default",
  ) {}

  async claim(id: string, now: number, leaseMs: number): Promise<ClaimResult> {
    const claimed = await this.db.query(
      `INSERT INTO webhook_received (scope, message_id, done, until) VALUES ($1, $2, false, $3)
       ON CONFLICT (scope, message_id) DO UPDATE SET done = false, until = EXCLUDED.until
       WHERE webhook_received.until <= $4
       RETURNING message_id`,
      [this.scope, id, now + leaseMs, now],
    );
    if (claimed.rows.length) return "claimed";
    const { rows } = await this.db.query("SELECT done FROM webhook_received WHERE scope = $1 AND message_id = $2", [this.scope, id]);
    return rows[0]?.done ? "duplicate" : "in-progress";
  }

  async complete(id: string, now: number, retainMs: number): Promise<void> {
    await this.db.query("UPDATE webhook_received SET done = true, until = $1 WHERE scope = $2 AND message_id = $3", [
      now + retainMs,
      this.scope,
      id,
    ]);
  }

  async release(id: string): Promise<void> {
    await this.db.query("DELETE FROM webhook_received WHERE scope = $1 AND message_id = $2", [this.scope, id]);
  }
}

/** Endpoint configuration, for a dispatcher and dashboard that manage endpoints at runtime. */
export class PostgresEndpointStore implements EndpointStore {
  constructor(private readonly db: SqlClient) {}

  async list(): Promise<Endpoint[]> {
    const { rows } = await this.db.query("SELECT data FROM webhook_endpoints ORDER BY id");
    return rows.map((r) => (typeof r.data === "string" ? JSON.parse(r.data) : r.data));
  }

  async get(id: string): Promise<Endpoint | undefined> {
    const { rows } = await this.db.query("SELECT data FROM webhook_endpoints WHERE id = $1", [id]);
    if (!rows.length) return undefined;
    return typeof rows[0].data === "string" ? JSON.parse(rows[0].data) : rows[0].data;
  }

  async save(endpoint: Endpoint): Promise<void> {
    await this.db.query(
      "INSERT INTO webhook_endpoints (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",
      [endpoint.id, JSON.stringify(endpoint)],
    );
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query("DELETE FROM webhook_endpoints WHERE id = $1", [id]);
    return rowCount === 1;
  }
}
