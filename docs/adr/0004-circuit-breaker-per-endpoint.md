# 0004 · A circuit breaker per endpoint

- Status: accepted
- Date: 2026-10-22

## Context

When an endpoint is down, every pending delivery to it keeps failing on its own schedule. With a few hundred messages queued, the dispatcher sends a few hundred requests that are known to fail, each one waiting for a timeout and using up one of that delivery's attempts. When the endpoint comes back, it receives all of them at once.

## Decision

Keep a breaker per endpoint, in the store:

- Count consecutive failed attempts (no response, 408, 429, 5xx). Any response that shows the endpoint is up (2xx or 4xx) resets the count.
- After `failureThreshold` failures (5), open the breaker for `cooldownMs` (30 s). Each consecutive opening doubles the cooldown, up to 30 minutes.
- While it is open, due deliveries are postponed to the end of the cooldown. Postponing does not count as an attempt.
- After the cooldown, the next delivery is a probe. If it fails, the breaker opens again immediately. If it succeeds, the breaker closes and the counters reset.

## Consequences

- In the simulator, the endpoint that is down for 20 minutes receives 10 requests during the outage. With the breaker turned off it receives 390.
- Messages are not dead-lettered because an endpoint was down for a while; only `maxAgeMs` limits how long they wait.
- Breaker state is shared through the store with last-write-wins. Two workers may both send a probe, or count a failure once instead of twice. The breaker only needs to be roughly right, so this was preferred over making every attempt a conditional write on the endpoint row.
- Deliveries to the same endpoint are sent one after another within a tick, which keeps the probe meaningful and limits the load on a recovering endpoint. Different endpoints are sent in parallel.
