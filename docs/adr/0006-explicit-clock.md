# 0006 · An explicit clock

- Status: accepted
- Date: 2026-10-22

## Context

Most of the behaviour is about time: backoff delays, `Retry-After`, cooldowns, leases, maximum age, timestamp tolerance. Code that reads `Date.now()` wherever it needs it can only be tested by waiting, or by mocking global timers.

## Decision

Every method that depends on time takes `now` as an optional argument: `publish`, `prepare`, `tick`, `redeliver`, `verifyWebhook` and `WebhookReceiver.handle`. Without it, they read the real clock. The library owns no timers except the optional `start()` loop. Randomness for jitter and id generation can be injected the same way.

## Consequences

- Tests check exact boundaries (`nextAttemptAt - 1` versus `nextAttemptAt`) without waiting.
- The simulator runs about an hour and a half of traffic, including a 20 minute outage, in a few tens of milliseconds, and the same seed always gives the same log.
- The transport receives the dispatcher's `now`, so a simulated endpoint can behave according to simulated time.
