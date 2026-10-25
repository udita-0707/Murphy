# ADR 007: Lease reaper and poison guard

- Status: Accepted
- Date: 2026-10-26

## Context

A worker leases each delivery it claims (`in_flight`, `locked_by`, `locked_until`, ADR 004).
If the worker is killed (SIGKILL, OOM, a crashed VM), it cannot release its leases, and those
deliveries would stay `in_flight` forever. Graceful shutdown releases leases itself; this ADR
covers everything else.

A delivery that reliably crashes the worker (a "poison" delivery, for example a payload that
triggers a bug) would be reaped and retried forever if reaps were free, taking a worker down
each time.

## Decision

**Reaper.** Every worker runs a reaper every `WORKER_REAP_INTERVAL_MS` (10 s). One pass, in
one transaction:

1. Lock up to 100 expired leases: `status = 'in_flight' AND locked_until < now()`, oldest
   first, with `FOR UPDATE SKIP LOCKED`. Concurrent reapers in different workers take
   disjoint rows.
2. For each row: log an attempt with `error = 'lease_expired'` (the next `attempt_no`, no
   response), increment `reap_count`, clear the lease and set the delivery back to `pending`
   with `next_attempt_at = now()`.

Reaped attempts do **not** count toward `attempt_count` (the backoff counter): the receiver
may never have seen the request, and the worker's death is not the receiver's fault.

**Poison guard.** The first 3 reaps of a delivery are free. From the 4th reap on, each reap
counts as a failed attempt: `attempt_count` is incremented, the delivery is backed off on the
normal schedule (5 s, 30 s, ...) instead of being due immediately, and when the schedule is
exhausted it goes `dead` and appears in the DLQ. The attempt row says so, for example
`lease_expired: reaped 4 times, counted as attempt 1`. A replay resets `reap_count`.

**Late writes.** A worker that was merely slow (not dead) may finish after its lease was
reaped. Its final write is guarded by `status = 'in_flight' AND locked_by = <itself>` (ADR 003),
so it logs its attempt but does not overwrite the state set by the reaper or by the worker
that took over.

**Lease length.** The lease (60 s) must exceed the request timeout (10 s) plus a 15 s safety
margin; the worker refuses to start otherwise (ADR 004). A healthy request therefore always
finishes, and records its outcome, before its lease can expire.

## Consequences

- A worker killed mid-delivery delays that delivery by at most the lease length plus one
  reaper interval (about 70 s by default), and never loses it.
- **Duplicates are possible** (at-least-once, ADR 001): if a worker dies after the receiver
  returned 2xx but before the worker recorded it, the reaped delivery is sent again with the
  same `webhook-id`. Receivers must deduplicate on `webhook-id` (ADR 006).
- A poison delivery costs at most 3 free crashes plus the normal schedule, then lands in the
  DLQ where it can be inspected and replayed.
- Every reap is visible in the delivery log, so a flapping worker shows up in the data.

## Alternatives considered

- **Hold a database transaction for the whole HTTP request** (no leases): ties up a
  connection per in-flight request, and a crashed worker's locks only clear when Postgres
  notices the dead connection.
- **Count every reap as an attempt:** punishes the receiver for Murphy's own crashes, and a
  rolling deploy could burn a delivery's retry budget.
- **Never count reaps:** a poison delivery loops forever.
- **A separate reaper service:** one more process to run and monitor; running it in every
  worker with `SKIP LOCKED` is just as safe.
