# 0009 · Ordering keys

- Status: accepted
- Date: 2026-10-23

## Context

Retries reorder messages. If `order.paid` fails once and `order.shipped` succeeds right after, the receiver sees the order shipped before it was paid. Receivers can defend themselves by comparing versions, but many do not, and for some sequences (created, then updated) there is nothing sensible to do with the later event first.

Strict order for every message to an endpoint would mean one failing message holds up everything behind it. Usually only events about the same entity need to stay in order.

## Decision

- `WebhookEvent.orderingKey` is optional. Deliveries keep the key and a `sequence`: the publish time in microseconds, made strictly increasing within the dispatcher, so two events published in the same millisecond keep their order.
- Before sending a delivery with a key, the dispatcher asks the store for the head: the `pending` or `sending` delivery with the lowest sequence for that endpoint and key (`DeliveryStore.head`). If the head is another delivery, this one is postponed without an attempt: until the head's next attempt, or by one second if the head is being sent right now.
- A dead-lettered head no longer blocks the key. The alternative, blocking until someone redelivers it, would hold every later event for that entity indefinitely because of one bad payload.
- `head` and `purge` are optional store methods, so stores written for earlier versions keep working. Publishing with a key on a store without `head` throws.

## Consequences

- Order holds per endpoint and key, across retries, workers and `maxConcurrency`.
- One extra indexed query per keyed delivery. PostgreSQL: a partial index on `(endpoint_id, ordering_key, sequence)` over unfinished rows.
- Events published by different processes in the same millisecond are ordered by their clocks, which may differ slightly. Publish related events from one place, or let the receiver compare versions.
- A delivery that waits behind a failing head for longer than `maxAgeMs` is dead-lettered as `expired`, like any other.
- Redelivering a dead head puts it back with its old sequence. Later events that were already delivered are not sent again, so the receiver sees the redelivered one last.
