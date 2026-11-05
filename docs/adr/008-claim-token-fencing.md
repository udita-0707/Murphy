# ADR 008: Fence worker writes with a claim token

- Status: Accepted
- Date: 2026-11-05

## Context

A worker's final write was guarded by `status = 'in_flight' AND locked_by = <worker id>` (ADR 003,
ADR 007). That identifies the worker, not the lease. The model-based test found a sequence the
guard lets through (fast-check seed 1990363018):

```
ingest -> claim(w0) -> expire_lease -> reap -> claim(w0) -> complete(first task, 500)
```

A worker that stalls past its lease, is reaped and claims the same delivery again now holds two
tasks for it. The old task passes the guard, ends the new lease with a stale result, and the new
task's write is then ignored. Because `attempt_count` was written as a value computed before the
request, the count could also go backwards, which breaks the backoff schedule and the poison
guard. It needs a stall longer than the lease (a VM pause or a laptop sleeping), so it is rare, but
nothing prevented it.

## Decision

- `deliveries.claim_token` (uuid, nullable) gets a new random value on every claim and is cleared
  whenever the lease ends: on a recorded outcome, reap, release, cancel or replay.
- `loadContext` and `recordAttempt` take the token instead of the worker id. The guard is
  `status = 'in_flight' AND claim_token = <token>`.
- `locked_by` stays for the delivery log and for releasing a worker's leases on shutdown. It is no
  longer what makes a write safe.
- `attempt_count` is incremented in place (`attempt_count + 1`). `client_error_count` is still
  written from the value computed by the policy, which the token guard makes safe, since only the
  current lease can write.
- The worker keys its in-memory work by token, so an old task finishing cannot free the slot of
  its re-claim.

A late write is still logged as an attempt, as before.

## Consequences

- A stale task can no longer change a delivery in any interleaving, including the same worker
  re-claiming. Regression tests are in `apps/worker/test/reaper.integration.test.ts`, and the
  model-based test covers it on every run.
- One extra uuid column and one more column to clear. There is no new index, since every guarded
  write already finds its row by primary key.
- `AttemptOutcome.attemptCount` is no longer written. It remains in the policy's result because
  the policy needs it to choose the backoff step.

## Alternatives considered

- **A lease counter (`lease_seq`):** works equally well, but a uuid cannot be guessed or confused
  across a replay and needs no read-modify-write.
- **Comparing `locked_until` as the token:** relies on timestamp equality across a round trip.
- **Make worker ids unique per claim:** would lose the link between a lease and its worker, which
  the delivery log and shutdown rely on.
