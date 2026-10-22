# 0003 · At-least-once delivery, idempotent receivers

- Status: accepted
- Date: 2026-10-22

## Context

Over HTTP the sender cannot always know whether a request was processed. If the connection drops after the receiver committed but before the response arrives, the sender sees a timeout. It can either retry (and maybe deliver twice) or not retry (and maybe lose the message). There is no third option without the receiver's help.

## Decision

The sender retries. Delivery is at least once.

The receiver absorbs the duplicates. `WebhookReceiver` keeps the ids it has processed in an `IdempotencyStore`:

1. Verify the signature first, so unsigned requests never reach the store.
2. Claim the id atomically. If it was already processed, answer 200 without calling the handler. If another request for the same id is still running, answer 503 with `Retry-After`.
3. Run the handler. On success, mark the id as processed and keep it for `retainMs`. On failure, release the claim and answer 500, so the sender's next retry runs the handler again.

A claim carries a lease. If the process dies while the handler runs, the id becomes claimable again when the lease expires.

## Consequences

- The handler runs once per message as long as the id is retained. `retainMs` (4 days by default) must be longer than the sender's retry window (3 days by default).
- "Once" holds for the claim, not for side effects outside the store. If the handler calls a third party and then the process dies before `complete`, the next delivery calls it again. Handlers with external side effects should make those idempotent too, for example by passing the message id along as an idempotency key.
- A receiver that does not use this library can still deduplicate on `webhook-id`.
- The simulator checks this end to end: 5% of responses on one endpoint are lost after processing, and every message must still be handled exactly once.
