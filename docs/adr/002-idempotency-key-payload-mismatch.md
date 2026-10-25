# ADR 002: Idempotency-Key reuse with a different payload

- Status: Accepted
- Date: 2026-10-25

## Context

`POST /v1/events` requires an `Idempotency-Key` header, and the brief defines
`UNIQUE (project_id, idempotency_key)` on `events`. The brief does not say what happens when
a client reuses a key. Two cases matter:

1. A genuine retry: the client did not see the first response (timeout, network error) and
   sends the same request again.
2. A client bug: the same key is reused for a different event. Silently returning the
   original event would hide the bug and the second event would be lost without the client
   noticing.

This is a deviation from (or rather a refinement of) the brief, which only requires the key.

## Decision

- **Same key, same canonical payload and same type:** replay the original response. Return
  `202` with the original event id and delivery count, plus the header
  `Idempotent-Replayed: true`. No new rows are written.
- **Same key, different payload or different type:** return `409` with error code
  `idempotency_key_reused`.
- **Comparison:** compute a SHA-256 hash (hex) of canonical JSON of `{ type, payload }`,
  where canonical JSON recursively sorts object keys and leaves array order unchanged. Store
  it on the event row as `events.request_hash`. Comparing hashes means key order and
  whitespace in the client's JSON do not matter.
- **Concurrency:** the insert uses `INSERT ... ON CONFLICT (project_id, idempotency_key) DO
  NOTHING` inside the accepting transaction. The loser of a race reads the winner's row and
  applies the rules above, so concurrent requests with the same key produce exactly one
  event.

## Consequences

- Retries are safe and cheap, and clients can tell a replay from a fresh acceptance.
- Key misuse is surfaced as an explicit error rather than silent data loss.
- Keys are scoped per project, so two tenants can use the same key independently.
- Keys are kept as long as the event row is kept; retention deletes them along with the
  event. A key reused after retention expiry is treated as new.
- Clients must send byte-for-byte equivalent JSON values (after key sorting) on retries.
  Numerically equal but differently written numbers (`1` vs `1.0`) are parsed by JSON to the
  same value, so they hash the same.

## Alternatives considered

- **Always replay the original, ignore the new payload** (Stripe's early behaviour): simple,
  but hides client bugs.
- **Store the full response body and replay it verbatim:** more general, but the response is
  derivable from the event row, so an extra column is unnecessary.
- **Compare the raw request body:** brittle; key order or whitespace changes would cause
  false 409s.
