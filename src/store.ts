import type { Delivery, DeliveryStatus, EndpointState } from "./types.js";

export interface DeliveryQuery {
  status?: DeliveryStatus;
  endpointId?: string;
  messageId?: string;
  limit?: number;
}

/**
 * Where deliveries and endpoint state live between attempts. This is the
 * outbox: publishing writes here, workers read from here. Any database with
 * a conditional update works.
 *
 * Every change to a delivery is conditional on the version that was read, so
 * several workers (or function invocations) can share one store without
 * sending the same attempt twice.
 */
export interface DeliveryStore {
  /** Inserts deliveries whose id is not stored yet and skips the rest. Returns how many were inserted. */
  insert(deliveries: Delivery[]): Promise<number>;
  get(id: string): Promise<Delivery | undefined>;
  /**
   * Deliveries with status `pending` or `sending` and `nextAttemptAt <= now`,
   * earliest first, at most `limit`. Index `(status, nextAttemptAt)`.
   */
  due(now: number, limit: number): Promise<Delivery[]>;
  /**
   * Writes the delivery only if the stored version equals `expectedVersion`.
   * The stored version becomes `expectedVersion + 1`. Returns `false` on conflict.
   */
  update(delivery: Delivery, expectedVersion: number): Promise<boolean>;
  list(query: DeliveryQuery): Promise<Delivery[]>;
  getEndpointState(endpointId: string): Promise<EndpointState | undefined>;
  /** Last write wins. Breaker counters are advisory, see ADR 0004. */
  saveEndpointState(state: EndpointState): Promise<void>;
}

/**
 * Reference store kept in process memory. For tests, local development and
 * the simulator, and as a template for a real store. Rows are copied in and
 * out, like a database would, so callers cannot mutate stored state.
 */
export class MemoryDeliveryStore implements DeliveryStore {
  private readonly rows = new Map<string, Delivery>();
  private readonly endpoints = new Map<string, EndpointState>();

  get size(): number {
    return this.rows.size;
  }

  async insert(deliveries: Delivery[]): Promise<number> {
    await tick();
    let inserted = 0;
    for (const d of deliveries) {
      if (this.rows.has(d.id)) continue;
      this.rows.set(d.id, copy({ ...d, version: 1 }));
      inserted++;
    }
    return inserted;
  }

  async get(id: string): Promise<Delivery | undefined> {
    await tick();
    const row = this.rows.get(id);
    return row && copy(row);
  }

  async due(now: number, limit: number): Promise<Delivery[]> {
    await tick();
    return [...this.rows.values()]
      .filter((d) => (d.status === "pending" || d.status === "sending") && d.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .slice(0, limit)
      .map(copy);
  }

  async update(delivery: Delivery, expectedVersion: number): Promise<boolean> {
    await tick();
    const current = this.rows.get(delivery.id);
    if (!current || current.version !== expectedVersion) return false;
    this.rows.set(delivery.id, copy({ ...delivery, version: expectedVersion + 1 }));
    return true;
  }

  async list(query: DeliveryQuery): Promise<Delivery[]> {
    await tick();
    return [...this.rows.values()]
      .filter((d) => !query.status || d.status === query.status)
      .filter((d) => !query.endpointId || d.endpointId === query.endpointId)
      .filter((d) => !query.messageId || d.messageId === query.messageId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, query.limit ?? Infinity)
      .map(copy);
  }

  async getEndpointState(endpointId: string): Promise<EndpointState | undefined> {
    await tick();
    const state = this.endpoints.get(endpointId);
    return state && { ...state };
  }

  async saveEndpointState(state: EndpointState): Promise<void> {
    await tick();
    this.endpoints.set(state.endpointId, { ...state });
  }
}

function copy(d: Delivery): Delivery {
  return { ...d, history: d.history.map((a) => ({ ...a })) };
}

/** Yields so that concurrent callers interleave, as they would against a real database. */
function tick(): Promise<void> {
  return Promise.resolve();
}
