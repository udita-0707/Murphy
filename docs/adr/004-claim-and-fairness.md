# ADR 004: Claiming deliveries with per-project fairness

- Status: Accepted
- Date: 2026-10-25

## Context

Workers pull due deliveries from the `deliveries` outbox (ADR 001). The brief's claim query
orders all due rows by `next_attempt_at` and takes the first N. With that query a tenant that
enqueues 100,000 deliveries fills every batch until its backlog drains, so a tenant with one
delivery waits behind all of them. The brief requires that a tenant flooding 50x its quota
does not raise other tenants' p95 latency by more than 20 percent.

Several workers run at once, so a row must never be claimed by two of them, and a crashed
worker must not hold rows forever.

## Decision

One SQL statement per claim, in `createDeliveryQueue().claim()` (`packages/db/src/queue.ts`):

1. `due_projects`: the distinct projects that have at least one due pending delivery.
2. For each such project, a `LATERAL` subquery selects that project's oldest due rows,
   `ORDER BY next_attempt_at LIMIT projectCap FOR UPDATE OF d SKIP LOCKED`. It joins
   `endpoints` and only takes rows whose endpoint is `active` and not soft-deleted, so
   deliveries of disabled, paused or deleted endpoints stay parked.
3. Candidates are ranked within their project (`row_number()`), and the batch takes rank 1
   of every project, then rank 2, and so on, up to the batch size. Every project with due
   work gets a row before any project gets a second.
4. The chosen rows are updated to `in_flight` with `locked_by = <worker id>` and
   `locked_until = now() + lease` (60 s by default), and returned.

A partial index `deliveries (project_id, next_attempt_at) WHERE status = 'pending'` serves
step 2. Prisma's schema language cannot express partial indexes, so it lives only in the
migration `20261025130000_pending_claim_index`; any `DROP INDEX` for it that
`prisma migrate dev` generates later must be deleted from the generated migration.

Worker settings: `WORKER_BATCH_SIZE` (50), `WORKER_PROJECT_CAP` (10), `WORKER_CONCURRENCY`
(20), `WORKER_POLL_MS` (500), lease 60 s, request timeout 10 s. Config loading fails fast
unless the lease exceeds the request timeout plus a 15 s safety margin, so a healthy but slow
request is never reaped and sent twice.

The worker id is `hostname:pid:random`. On SIGTERM/SIGINT the worker stops claiming, waits for
in-flight deliveries up to `WORKER_SHUTDOWN_TIMEOUT_MS` (15 s), then aborts the rest and
returns their leases to `pending` without counting an attempt. A worker killed without a
chance to clean up leaves its leases to the reaper (ADR 007).

## Consequences

- A flooding project is limited to `projectCap` rows per claim per worker, and a project with
  one due delivery is claimed in the next batch (tested: 1000 due rows in project A, 1 in
  project B, B is in the first batch).
- `SKIP LOCKED` makes concurrent workers disjoint without blocking each other (tested with
  four workers draining 300 rows: no row claimed twice).
- The `DISTINCT project_id` step scans all due pending rows. That is cheap at the target
  scale. If it becomes a hot spot, a small `projects_with_due_work` table or a loose index
  scan can replace it.
- Fairness is per claim, not global: rows locked by one worker's LATERAL subquery but not
  picked are released when the statement ends.
- The lease is held on rows, not connections, so long HTTP requests do not hold database
  transactions open.

## Alternatives considered

- **Brief's single ORDER BY claim:** simple, but unfair under floods.
- **Weighted random sampling across projects:** fair on average, but harder to test
  deterministically.
- **Per-project queues in Redis:** fast, but makes Redis a second source of truth (ADR 001).
