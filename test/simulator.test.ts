import { describe, expect, it } from "vitest";
import { runScenario } from "reliable-webhooks";

describe("simulated scenario", () => {
  it("handles every message exactly once on every endpoint, across seeds", async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = await runScenario({ seed, messages: 200 });
      expect(r.exactlyOnce, `seed ${seed}`).toBe(true);
      expect(r.deadRemaining).toBe(0);
    }
  });

  it("exercises every failure path", async () => {
    const r = await runScenario({ seed: 7 });
    const by = Object.fromEntries(r.endpoints.map((e) => [e.id, e]));
    expect(by.orders!.duplicatesAbsorbed).toBeGreaterThan(0);
    expect(by.crm!.retries).toBeGreaterThan(0);
    expect(by.analytics!.breakerOpenings).toBeGreaterThan(0);
    expect(r.log.some((l) => l.endpointId === "partner" && l.status === 429)).toBe(true);
    expect(by.legacy!.deadLettered).toBe(by.legacy!.expected);
    expect(r.redelivered).toBe(by.legacy!.expected);
  });

  it("gives the same result with several workers sharing the store", async () => {
    const r = await runScenario({ seed: 3, workers: 4, messages: 200 });
    expect(r.exactlyOnce).toBe(true);
  });

  it("sends far fewer requests to a down endpoint with the breaker on", async () => {
    const duringOutage = (r: Awaited<ReturnType<typeof runScenario>>) =>
      r.log.filter((l) => l.endpointId === "analytics" && l.at >= r.startedAt + 2 * 60_000 && l.at < r.startedAt + 22 * 60_000).length;
    const on = await runScenario({ seed: 7 });
    const off = await runScenario({ seed: 7, breaker: false });
    expect(off.exactlyOnce && on.exactlyOnce).toBe(true);
    expect(duringOutage(on) * 10).toBeLessThan(duringOutage(off));
  });

  it("is reproducible for a given seed", async () => {
    const a = await runScenario({ seed: 11 });
    const b = await runScenario({ seed: 11 });
    expect(a.log).toEqual(b.log);
  });

  it("leaves the misconfigured endpoint in the dead letters without redelivery", async () => {
    const r = await runScenario({ seed: 7, noRedelivery: true });
    expect(r.exactlyOnce).toBe(false);
    expect(r.deadRemaining).toBe(r.endpoints.find((e) => e.id === "legacy")!.expected);
  });
});
