# 0002 · What is retried, and how often

- Status: accepted
- Date: 2026-10-22

## Context

Endpoints fail in different ways. A deploy returns 502 for thirty seconds. A database outage returns 500 for an hour. A rate limiter returns 429 with `Retry-After`. A wrong secret returns 401 on every attempt, forever. Retrying everything the same way either gives up too early on the first group or wastes days of requests on the last one.

## Decision

Classify each attempt by status:

| Response | Action |
| --- | --- |
| 2xx | Delivered |
| No response (timeout, refused, DNS), 408, 425, 429, 5xx | Retry |
| 410 Gone | Dead letter, and disable the endpoint |
| Any other 4xx, and 3xx | Dead letter now |

Retries back off exponentially: 5 s, 25 s, about 2 min, 10 min, 52 min, 4.3 h, then 6 h, for 8 attempts in total (about 11 hours). The top 20% of each delay is random, so a burst of failures does not come back as a burst. `Retry-After` is honoured when it asks for longer, up to the 6 hour cap. A delivery whose next attempt would be more than 3 days after it was published is dead-lettered instead.

Redirects are not followed.

## Consequences

- A permanent error shows up in the dead letters within seconds, where someone can see it, instead of after a day of retries.
- Dead letters can be redelivered once the cause is fixed, with a fresh retry cycle. That is the recovery path for 4xx errors, not more retries.
- If an endpoint answers 400 for something temporary, the delivery is dead-lettered too early. That is a receiver bug; the dead letter keeps the full history so it can be diagnosed.
- Not following redirects avoids posting signed payloads to a location nobody configured. A moved endpoint appears as dead letters with status 301 or 308.
- All values are options. The schedule is close to what large webhook providers publish.
