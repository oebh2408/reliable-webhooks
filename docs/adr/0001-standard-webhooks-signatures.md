# 0001 · Signatures in the Standard Webhooks format

- Status: accepted
- Date: 2026-10-22

## Context

A receiver has to know that a request came from the sender and was not changed on the way. Every webhook provider solves this with an HMAC over the body, but each one picks its own header names, encoding and signed string. Receivers end up writing a verifier per provider, and small mistakes (comparing with `===`, verifying a re-serialized body, ignoring the timestamp) are common.

Standard Webhooks is a published specification for exactly this part, with reference libraries in several languages.

## Decision

Use the Standard Webhooks format as is:

- `webhook-id`: the message id, the same on every retry.
- `webhook-timestamp`: seconds since the epoch, set at each attempt.
- `webhook-signature`: `v1,` plus the base64 HMAC-SHA256 of `id.timestamp.body`. Several signatures may be listed, separated by spaces.
- Secrets are `whsec_` plus base64 bytes.

The verifier compares in constant time, rejects timestamps more than 5 minutes away from its clock, and works on the raw body.

## Consequences

- Receivers can use this library or any compatible one. The test suite checks the specification's published test vector.
- Including the timestamp in the signed string bounds replays to the tolerance window. Within that window, the receiver's idempotency check (ADR 0003) catches repeats.
- Each attempt is signed again with a new timestamp, so a retry three hours later is still inside the tolerance.
- Rotation: the sender signs with every secret of the endpoint. The receiver adds the new secret, the sender switches, then the old one is removed from both sides. No request fails during the change.
- Only symmetric signatures are supported. Asymmetric signatures (`v1a`) would let receivers verify without holding a secret; they can be added later without changing the headers.
