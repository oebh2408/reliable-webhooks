# 0008 · Private addresses, rate limits and concurrency per endpoint

- Status: accepted
- Date: 2026-10-22

## Context

With the dashboard, endpoint URLs can come from people rather than from code. A URL such as `http://169.254.169.254/` or `http://localhost:5432/` turns the dispatcher into a way to send requests from inside the network (server-side request forgery). Checking the URL when it is saved is not enough: a hostname can resolve to a public address when it is checked and to a private one when the request is made.

Separately, some receivers can only take a few requests per second, and others can take many in parallel. Until now every endpoint got one request at a time per worker, as fast as the endpoint answered.

## Decision

- The default transport is `httpTransport()`, built on `node:http`/`node:https` instead of `fetch`. It passes its own `lookup` function to the request. That function resolves the name, and fails with `ERR_BLOCKED_ADDRESS` if any resolved address is private, loopback, link-local, carrier-grade NAT, multicast or reserved (IPv4, IPv6, and IPv4 inside IPv6). Because it runs on the addresses the socket connects to, a changing DNS answer cannot get around it. Literal IP addresses in the URL are checked before connecting.
- A blocked request is classified as a rejection, not a network failure: sending again will not change the address, so the delivery is dead-lettered at once, with `blocked-address` as the error. It does not count against the breaker.
- `httpTransport({ allowPrivateNetworks: true })` turns the check off, for internal services and the playground. `fetchTransport()` stays available for runtimes without `node:http`; it does not check addresses.
- `Endpoint.rateLimit` is a token bucket in requests per second, with a burst of one second's worth. A delivery that finds no token is postponed until the next token, the same way as with an open breaker: no attempt is used.
- `Endpoint.maxConcurrency` (default 1, at most 50) sets how many deliveries to the endpoint a tick sends at once. The breaker state is shared between them.

## Consequences

- No new dependencies; the address ranges are a `net.BlockList`.
- Both limits are kept in memory and apply per dispatcher. Several dispatchers sharing a store can together send up to N times the rate. A limit shared through the store would need a write per request; dividing the limit between workers was preferred.
- With `maxConcurrency` above 1, several requests may be in flight when the breaker opens, and more than one probe may go out after a cooldown. The breaker only needs to be roughly right (ADR 0004).
- Redirects are still not followed, so a public URL cannot redirect into the network.
