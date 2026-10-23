import type { Outcome } from "./retry.js";
import type { DeadReason, DeliveryStatus, EndpointState } from "./types.js";
import type { DeliveryCount } from "./store.js";

/** Why a due delivery was pushed back without an attempt. */
export type PostponeReason = "breaker" | "paused" | "rate-limit" | "ordering";

/** Upper bounds of the request duration histogram, in seconds. */
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
/** Recent durations kept per endpoint for percentiles. */
const RECENT = 200;

interface EndpointCounters {
  attempts: Partial<Record<Outcome, number>>;
  dead: Partial<Record<DeadReason, number>>;
  postponed: Partial<Record<PostponeReason, number>>;
  delivered: number;
  buckets: number[];
  durationSum: number;
  durationCount: number;
  recent: number[];
}

export interface EndpointMetrics {
  endpointId: string;
  /** Attempts by outcome since the dispatcher started. */
  attempts: Partial<Record<Outcome, number>>;
  delivered: number;
  dead: Partial<Record<DeadReason, number>>;
  postponed: Partial<Record<PostponeReason, number>>;
  /** Share of the last 200 attempts that succeeded, from 0 to 1, or null with no attempts. */
  successRate: number | null;
  /** Percentiles of the last 200 request durations, in milliseconds. */
  p50Ms: number | null;
  p95Ms: number | null;
}

/**
 * Counters kept in memory by each dispatcher, since it started. With several
 * dispatchers, scrape each one and sum; queue sizes come from the store and
 * are the same for all of them.
 */
export class DispatcherMetrics {
  private readonly endpoints = new Map<string, EndpointCounters & { outcomes: boolean[] }>();
  private readonly purgedTotals: Record<"delivered" | "dead", number> = { delivered: 0, dead: 0 };

  attempt(endpointId: string, outcome: Outcome, durationMs: number): void {
    const c = this.get(endpointId);
    c.attempts[outcome] = (c.attempts[outcome] ?? 0) + 1;
    const seconds = durationMs / 1000;
    BUCKETS.forEach((le, i) => seconds <= le && c.buckets[i]!++);
    c.durationSum += seconds;
    c.durationCount++;
    c.recent.push(durationMs);
    c.outcomes.push(outcome === "success");
    if (c.recent.length > RECENT) c.recent.shift();
    if (c.outcomes.length > RECENT) c.outcomes.shift();
  }

  delivered(endpointId: string): void {
    this.get(endpointId).delivered++;
  }

  dead(endpointId: string, reason: DeadReason): void {
    const c = this.get(endpointId);
    c.dead[reason] = (c.dead[reason] ?? 0) + 1;
  }

  postponed(endpointId: string, reason: PostponeReason): void {
    const c = this.get(endpointId);
    c.postponed[reason] = (c.postponed[reason] ?? 0) + 1;
  }

  purged(status: "delivered" | "dead", count: number): void {
    this.purgedTotals[status] += count;
  }

  /** Per-endpoint figures, for dashboards and logs. */
  snapshot(): EndpointMetrics[] {
    return [...this.endpoints].map(([endpointId, c]) => {
      const sorted = [...c.recent].sort((a, b) => a - b);
      const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : null);
      return {
        endpointId,
        attempts: { ...c.attempts },
        delivered: c.delivered,
        dead: { ...c.dead },
        postponed: { ...c.postponed },
        successRate: c.outcomes.length ? c.outcomes.filter(Boolean).length / c.outcomes.length : null,
        p50Ms: pct(0.5),
        p95Ms: pct(0.95),
      };
    });
  }

  /**
   * The Prometheus text format. Pass the store's counts and endpoint states
   * to include queue sizes and breaker state.
   */
  prometheus(extra: { counts?: DeliveryCount[]; states?: EndpointState[]; now?: number } = {}): string {
    const out: string[] = [];
    const family = (name: string, type: string, help: string) => out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    const line = (name: string, labels: Record<string, string>, value: number) => {
      const l = Object.entries(labels).map(([k, v]) => `${k}="${escape(v)}"`).join(",");
      out.push(`${name}${l ? `{${l}}` : ""} ${value}`);
    };

    family("webhook_attempts_total", "counter", "Requests sent, by outcome.");
    for (const [endpoint, c] of this.endpoints) {
      for (const [outcome, n] of Object.entries(c.attempts)) line("webhook_attempts_total", { endpoint, outcome }, n);
    }
    family("webhook_attempt_duration_seconds", "histogram", "Request duration, including timeouts.");
    for (const [endpoint, c] of this.endpoints) {
      BUCKETS.forEach((le, i) => line("webhook_attempt_duration_seconds_bucket", { endpoint, le: String(le) }, c.buckets[i]!));
      line("webhook_attempt_duration_seconds_bucket", { endpoint, le: "+Inf" }, c.durationCount);
      line("webhook_attempt_duration_seconds_sum", { endpoint }, round(c.durationSum));
      line("webhook_attempt_duration_seconds_count", { endpoint }, c.durationCount);
    }
    family("webhook_delivered_total", "counter", "Deliveries that succeeded.");
    for (const [endpoint, c] of this.endpoints) line("webhook_delivered_total", { endpoint }, c.delivered);
    family("webhook_dead_letters_total", "counter", "Deliveries dead-lettered, by reason.");
    for (const [endpoint, c] of this.endpoints) {
      for (const [reason, n] of Object.entries(c.dead)) line("webhook_dead_letters_total", { endpoint, reason }, n);
    }
    family("webhook_postponed_total", "counter", "Due deliveries pushed back without an attempt, by reason.");
    for (const [endpoint, c] of this.endpoints) {
      for (const [reason, n] of Object.entries(c.postponed)) line("webhook_postponed_total", { endpoint, reason }, n);
    }
    family("webhook_purged_total", "counter", "Finished deliveries deleted by purge().");
    for (const [status, n] of Object.entries(this.purgedTotals)) line("webhook_purged_total", { status }, n);

    if (extra.counts) {
      family("webhook_deliveries", "gauge", "Deliveries in the store, by status.");
      for (const c of extra.counts) line("webhook_deliveries", { endpoint: c.endpointId, status: c.status as DeliveryStatus }, c.count);
    }
    if (extra.states) {
      const now = extra.now ?? Date.now();
      family("webhook_breaker_open", "gauge", "1 while the endpoint's circuit breaker is open.");
      for (const s of extra.states) line("webhook_breaker_open", { endpoint: s.endpointId }, s.openUntil > now ? 1 : 0);
      family("webhook_endpoint_disabled", "gauge", "1 when the endpoint was disabled by a 410.");
      for (const s of extra.states) line("webhook_endpoint_disabled", { endpoint: s.endpointId }, s.disabled ? 1 : 0);
    }
    return out.join("\n") + "\n";
  }

  private get(endpointId: string) {
    let c = this.endpoints.get(endpointId);
    if (!c) {
      c = {
        attempts: {},
        dead: {},
        postponed: {},
        delivered: 0,
        buckets: BUCKETS.map(() => 0),
        durationSum: 0,
        durationCount: 0,
        recent: [],
        outcomes: [],
      };
      this.endpoints.set(endpointId, c);
    }
    return c;
  }
}

function escape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
