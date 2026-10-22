import type { Endpoint } from "./types.js";

/**
 * Where endpoint configuration lives when it is managed at runtime (for
 * example from the dashboard) instead of in code. A dispatcher given an
 * `EndpointStore` reads it on every publish and tick, so every process
 * sharing the store sees changes without a restart.
 */
export interface EndpointStore {
  list(): Promise<Endpoint[]>;
  get(id: string): Promise<Endpoint | undefined>;
  /** Inserts or replaces. */
  save(endpoint: Endpoint): Promise<void>;
  delete(id: string): Promise<boolean>;
}

/** Reference store kept in process memory. */
export class MemoryEndpointStore implements EndpointStore {
  private readonly rows = new Map<string, Endpoint>();

  constructor(initial: Endpoint[] = []) {
    for (const e of initial) this.rows.set(e.id, clone(e));
  }

  async list(): Promise<Endpoint[]> {
    return [...this.rows.values()].map(clone);
  }

  async get(id: string): Promise<Endpoint | undefined> {
    const e = this.rows.get(id);
    return e && clone(e);
  }

  async save(endpoint: Endpoint): Promise<void> {
    this.rows.set(endpoint.id, clone(endpoint));
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

function clone(e: Endpoint): Endpoint {
  return structuredClone(e);
}
