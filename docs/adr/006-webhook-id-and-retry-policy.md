# ADR 006: Webhook identity, signing per attempt and the retry policy

- Status: Accepted
- Date: 2026-10-26

## Context

Receivers need a stable identifier to deduplicate deliveries, because Murphy delivers at
least once (ADR 001): a retry, a reaped lease (ADR 007) or a replay can send the same event
to the same endpoint again. They also need signatures they can verify, and those signatures
must not go stale when a delivery is retried hours later or replayed days later.

The brief (3.5) lists which responses to retry, but leaves open how often to retry 4xx
configuration errors, what to do on 410, and what counts toward the attempt limit.

## Decision

**Request format.**

- `webhook-id: msg_<event id>`. It is the same across retries, reaps and replays of that
  event, and the same for every endpoint that receives the event.
- `webhook-timestamp` and `webhook-signature` are generated fresh for every attempt,
  including replays, from the worker's clock at send time. A delivery replayed an hour (or a
  week) after the original still verifies within the receiver's 5-minute tolerance.
- The body is the event's `payload` serialised as JSON, as stored. Murphy does not wrap it in
  an envelope; the event type is expected inside the payload, as provider payloads already do
  (for example Razorpay's `"event": "payment.captured"`).
- The endpoint's signing secret is decrypted only in the worker, only for the duration of one
  attempt. Logged request headers include the signature but never the secret.

**Outcomes** (`decideOutcome` in `apps/worker/src/policy.ts`):

| Result                                                        | Outcome                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| 2xx                                                           | `succeeded`                                              |
| Timeout, network error, DNS failure, 5xx, 408, 425, 429       | retry on the schedule; `dead` when it is exhausted       |
| 400, 401, 403, 404                                            | retried at most twice since the last replay, then `dead` |
| 410                                                           | `dead`, and the endpoint is set to `disabled`            |
| Any other status (3xx, other 4xx, 1xx), blocked target (SSRF) | `dead`                                                   |
| Aborted by worker shutdown                                    | attempt logged as `worker_shutdown`; delivery unchanged  |

**Schedule.** `nextRetryDelay` from `@murphy/core`: 5 s, 30 s, 2 m, 10 m, 30 m, 1 h, 3 h, 6 h,
each with ±20% jitter. That is one initial attempt plus eight retries; the ninth failed
attempt makes the delivery `dead`. `Retry-After` replaces the scheduled delay, capped at 6 h.

**Counters on the delivery row.**

- `attempt_count`: real attempts since the last replay. It drives the backoff schedule.
  Reaped leases do not count, except under the poison guard (ADR 007). A replay resets it
  to 0, so a replayed delivery starts the schedule again.
- `client_error_count`: 400/401/403/404 responses since the last replay. A replay resets it.
  A dedicated column was simpler and clearer than recomputing the count from the attempt log
  on every attempt.
- `delivery_attempts.attempt_no` never resets. It keeps increasing across retries, reaps and
  replays, so the log reads as one timeline.

**410 Gone.** The receiver is telling us the endpoint no longer exists. The delivery goes
`dead` and the endpoint is set to `disabled`. Its other deliveries stay `pending` but are not
claimed (parked, ADR 004). `PATCH /v1/endpoints/:id {"status":"active"}` releases them.

**Guarded writes.** The final update after an attempt only applies while the delivery is
still `in_flight` and leased to this worker (ADR 003). The attempt row is written either way.

**Statuses.** `failed` stays in the enum but is unused: a delivery waiting for a retry is
`pending` with `attempt_count > 0`, and every terminal failure is `dead`, so the DLQ is one
query.

## Consequences

- Receivers can deduplicate on `webhook-id` alone, and the Murphy SDK's dedup helper will do
  exactly that.
- Because the timestamp is fresh per attempt, the signature cannot be used by receivers to
  detect that a request is a retry; they should rely on `webhook-id`.
- Configuration errors (wrong path, missing auth) stop after three attempts instead of nine,
  which keeps the DLQ honest and avoids hammering a misconfigured receiver for 12 hours.
- A receiver behind a redirect must register its final URL (ADR 005).

## Alternatives considered

- **New `webhook-id` per attempt:** makes receiver-side deduplication impossible.
- **Sign once at enqueue time:** replays and late retries would fail timestamp tolerance.
- **Wrap the payload in `{type, timestamp, data}`:** the Standard Webhooks suggestion, but it
  would make simulated provider payloads differ from what the real provider sends. Revisit if
  receivers ask for the type outside the payload (a `webhook-event-type` header is an option).
- **Count client errors from `delivery_attempts`:** no schema change, but needs a query per
  attempt and a definition of "since the last replay" based on timestamps.
