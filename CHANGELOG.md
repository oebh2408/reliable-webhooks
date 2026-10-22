# Changelog

## 0.2.0

- Dashboard: endpoints (create, edit, pause, delete), secret rotation, health per endpoint, deliveries with every attempt and the body, redelivery, test events and publishing. Built with React and shadcn/ui, compiled into the package and served by `createDashboard()`, a plain `node:http` handler. Optional bearer token. See ADR 0007.
- `npm run dashboard` starts a playground with five local receivers that fail in different ways.
- `EndpointStore` (`MemoryEndpointStore`, PostgreSQL example): the dispatcher can read endpoints from a store on every publish and tick.
- `Endpoint.paused`: deliveries are held without using up attempts.
- `WebhookEvent.endpointIds`: send to specific endpoints only.
- `DeliveryStore.counts()` and `DeliveryQuery.order`.
- Ticks may overlap; a slow endpoint no longer delays the others.
- Installable from GitHub (`npm install github:oebh2408/reliable-webhooks`); the package builds on install.

## 0.1.0

- `WebhookDispatcher`: outbox-based sending with retries, exponential backoff with jitter, `Retry-After`, a circuit breaker per endpoint, dead letters and redelivery. Several dispatchers can share one store (leases and conditional updates).
- `WebhookReceiver`: signature and timestamp verification, and idempotent handling by message id.
- Signatures in the Standard Webhooks format, with secret rotation.
- `MemoryDeliveryStore` and `MemoryIdempotencyStore`; PostgreSQL versions of both under `examples/`, tested with PGlite.
- `fetchTransport` and `nodeHandler` for plain Node.
- Simulator with five misbehaving endpoints and an exactly-once check, CLI demo and animated README demo.
