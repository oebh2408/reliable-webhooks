# Changelog

## 0.4.0

- Ordering keys: events with the same `orderingKey` reach each endpoint in the order they were published, across retries and workers. New optional store method `head()`; the PostgreSQL example adds three columns and two indexes (`SCHEMA` adds them to existing tables). See ADR 0009.
- ed25519 signatures (`v1a`) with `whsk_` secret keys; receivers verify with the `whpk_` public key. `generateKeyPair()` and `publicKeyFor()`. See ADR 0010.
- Metrics: `dispatcher.metrics` (attempts by outcome, durations, dead letters and postponements by reason) and `dispatcher.prometheus()`. The dashboard shows success rate and p95 per endpoint and serves `api/metrics`.
- Cleanup: `dispatcher.purge()` and the `retention` option. New optional store method `purge()`.
- Dashboard: add ed25519 keys and copy their public key; ordering key when sending an event.
- Publishing workflow for npm on GitHub releases.

## 0.3.0

- The default transport is now `httpTransport()`, on `node:http`. It refuses private, loopback, link-local and reserved addresses after DNS resolution, so endpoint URLs cannot reach the internal network. `allowPrivateNetworks: true` turns this off. Blocked requests are dead-lettered with the error `blocked-address`. See ADR 0008.
- `Endpoint.rateLimit` (requests per second) and `Endpoint.maxConcurrency` (requests in flight), per dispatcher. Both can be set in the dashboard, together with the timeout.
- `isPrivateAddress()` and `BlockedAddressError` are exported.

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
