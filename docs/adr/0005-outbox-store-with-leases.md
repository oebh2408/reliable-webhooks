# 0005 · The outbox: a store with leases and conditional updates

- Status: accepted
- Date: 2026-10-22

## Context

A dispatcher that keeps its queue in memory loses it on restart, and cannot run as more than one process. Webhooks are often published from serverless functions or from several instances of an API, and sent from a scheduled job or a separate worker.

There is also the question of when to publish. If the application commits an order and then publishes the webhook, a crash in between loses the webhook. If it publishes first, a rollback sends a webhook for an order that does not exist.

## Decision

Everything goes through a `DeliveryStore`, one row per message and endpoint. The interface is small (insert, get, due, conditional update, list, endpoint state) so that any database with a conditional write can implement it.

- Every change to a delivery is conditional on the version that was read.
- To send, a worker first takes a lease: it sets the status to `sending` and `nextAttemptAt` to now plus `leaseMs`, conditionally. Only one worker can win that write.
- After the attempt, the result is written conditionally on the leased version.
- If the worker dies mid-request, the delivery becomes due again when the lease expires, and another worker takes it over.
- `prepare()` builds the deliveries without writing them, so the application can insert them in the same transaction as its own change.

## Consequences

- Several dispatchers, or many function instances, can share one store. The test suite runs three dispatchers on one store, and the simulator runs up to four.
- A worker that is slow rather than dead can finish its request after its lease expired. The other worker may have sent the same message already. That is a duplicate, which receivers absorb (ADR 0003). The slow worker's result write fails and is ignored.
- `leaseMs` must be longer than the request timeout; the constructor enforces it.
- `due()` runs on every tick, so the store needs an index on `(status, nextAttemptAt)`. The PostgreSQL example has it and is tested against a real PostgreSQL engine (PGlite).
- Delivered rows are not deleted by the library. Retention is the application's choice, for example a periodic `DELETE ... WHERE status = 'delivered' AND created_at < ...`.
