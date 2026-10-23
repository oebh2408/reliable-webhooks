# 0010 · ed25519 signatures

- Status: accepted
- Date: 2026-10-23

## Context

With HMAC (ADR 0001) the sender and the receiver hold the same secret. Anyone who obtains it from the receiver's side (a log, a leaked environment, a former contractor) can sign webhooks the receiver will accept. The Standard Webhooks specification defines an asymmetric scheme for this: ed25519, signature identifier `v1a`, keys serialized as `whsk_` (secret) and `whpk_` (public) plus base64.

## Decision

- A secret that starts with `whsk_` signs with ed25519 over the same content as HMAC (`id.timestamp.body`) and produces `v1a,<base64 signature>`. Other secrets keep signing with HMAC as `v1`. An endpoint can have both, which is how a receiver migrates from one to the other.
- `verifyWebhook` and `WebhookReceiver` accept `whpk_` public keys next to `whsec_` secrets. Passing a `whsk_` secret key to the verifier throws: it means the secret key was handed to the receiver, which defeats the point.
- The key bytes are the raw 32-byte ed25519 seed and the raw 32-byte public key. The specification says "base64 encoded" without fixing the byte layout; raw keys are the common choice and the smallest.
- Node's `crypto` does the signing; no dependency is added.

## Consequences

- A leak on the receiver's side no longer allows forging. The sender's store still holds secret keys and must be protected as before.
- Signing and verifying ed25519 is slower than HMAC, but far below the cost of the HTTP request.
- Receivers on other platforms need an ed25519 implementation, which is available in every common language.
