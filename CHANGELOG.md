# Changelog

## 0.1.0

- `WebhookDispatcher`: outbox-based sending with retries, exponential backoff with jitter, `Retry-After`, a circuit breaker per endpoint, dead letters and redelivery. Several dispatchers can share one store (leases and conditional updates).
- `WebhookReceiver`: signature and timestamp verification, and idempotent handling by message id.
- Signatures in the Standard Webhooks format, with secret rotation.
- `MemoryDeliveryStore` and `MemoryIdempotencyStore`; PostgreSQL versions of both under `examples/`, tested with PGlite.
- `fetchTransport` and `nodeHandler` for plain Node.
- Simulator with five misbehaving endpoints and an exactly-once check, CLI demo and animated README demo.
