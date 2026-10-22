import { describe, expect, it } from "vitest";
import { classify, defaultRetryPolicy, parseRetryAfter, retryDelay } from "reliable-webhooks";

describe("retry policy", () => {
  it("classifies responses", () => {
    expect([200, 202, 299].map(classify)).toEqual(["success", "success", "success"]);
    expect([0, 408, 425, 429, 500, 502, 503, 504].map(classify)).toEqual(Array(8).fill("retry"));
    expect([301, 400, 401, 403, 404, 409, 422].map(classify)).toEqual(Array(7).fill("reject"));
    expect(classify(410)).toBe("gone");
  });

  it("backs off exponentially up to the cap", () => {
    const noJitter = () => 0;
    const delays = [1, 2, 3, 4, 5, 6, 7].map((n) => retryDelay(defaultRetryPolicy, n, noJitter));
    expect(delays).toEqual([5_000, 25_000, 125_000, 625_000, 3_125_000, 15_625_000, 21_600_000]);
  });

  it("randomizes only the top jitter fraction", () => {
    const max = retryDelay(defaultRetryPolicy, 3, () => 0);
    const min = retryDelay(defaultRetryPolicy, 3, () => 0.999999);
    expect(min).toBeGreaterThanOrEqual(max * 0.8);
    expect(min).toBeLessThan(max);
  });

  it("honours Retry-After when it asks for longer, within the cap", () => {
    expect(retryDelay(defaultRetryPolicy, 1, () => 0, 60_000)).toBe(60_000);
    expect(retryDelay(defaultRetryPolicy, 1, () => 0, 1_000)).toBe(5_000);
    expect(retryDelay(defaultRetryPolicy, 1, () => 0, 48 * 3600_000)).toBe(defaultRetryPolicy.maxDelayMs);
  });

  it("parses Retry-After as seconds or as a date", () => {
    const now = Date.parse("2026-01-12T09:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("Mon, 12 Jan 2026 09:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
  });
});
