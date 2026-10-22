# 0007 · A dashboard served by the library

- Status: accepted
- Date: 2026-10-22

## Context

Most of the day-to-day work around webhooks is operational: adding an endpoint for a new subscriber, giving them its secret, rotating that secret, finding out why deliveries to one endpoint are failing, and redelivering dead letters once it is fixed. With only a library, each team writes its own admin screens or does this in a database console.

The library has no runtime dependencies, and that should stay true for applications that do not use a dashboard.

## Decision

Ship a dashboard as part of the package:

- The page is a React application built with shadcn/ui components and Tailwind. It is compiled when the package is built, and the compiled files are published in `dashboard/dist`. React and the rest are development dependencies only.
- `createDashboard()` is a plain `node:http` handler that serves those files and a small JSON API over the dispatcher and the stores. No framework, no extra runtime dependency.
- Endpoint configuration moves into an `EndpointStore` that the dispatcher reads on every publish and tick, so changes made in the dashboard apply to every process sharing the store, without a restart. A fixed array of endpoints still works for applications that configure them in code.
- New dispatcher features that the dashboard needs, and that are useful without it: pausing an endpoint (deliveries are held without using up attempts), sending to specific endpoints only (test events), and counts per endpoint and status.

Security:

- With a `token`, every API call needs `Authorization: Bearer <token>`; the page asks for it and keeps it for the browser tab only.
- Without a token, the API only answers requests whose `Host` is localhost, so a page on another domain cannot reach it through DNS rebinding.
- `POST` requests must be `application/json`; `PATCH` and `DELETE` need a preflight anyway. Browsers cannot send that cross-site without a CORS preflight, which the server never approves, so a malicious page cannot post to a dashboard on localhost.
- The page is served with a strict Content-Security-Policy (scripts only from the same origin) and `frame-ancestors 'none'`.
- Lists and the overview never include secrets; only the endpoint detail does, because the operator needs to copy them.

`npm run dashboard` starts a playground: the dashboard with in-memory stores and a second local server that plays five receivers with different failures. It needs no account and nothing leaves the machine.

## Consequences

- The dashboard is optional. Applications that do not import `createDashboard` do not load any of it.
- The published package is larger (about 130 KB gzipped of static files).
- There is one shared token, not users and roles. For more than that, put the handler behind the application's own authentication, or a reverse proxy.
- `listEndpoints()` runs on every tick and publish. With a database store this is one small query; it can be cached by wrapping the store if it ever matters.
