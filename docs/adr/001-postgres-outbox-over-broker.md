# ADR 001: Postgres transactional outbox instead of a message broker

- Status: Accepted
- Date: 2026-10-25

## Context

Murphy accepts events through `POST /v1/events` and must deliver each one to every matching
endpoint at least once. The brief requires that no acknowledged event is lost on a worker or
database restart, that workers scale horizontally, and that the whole system runs on a
single small VM with managed Postgres and Redis on a student budget.

If the API wrote the event to Postgres and then published a message to a separate broker,
the two writes could diverge (the dual-write problem): a crash between them either loses a
delivery (event stored, message never published) or creates a phantom delivery (message
published, transaction rolled back).

## Decision

Use PostgreSQL itself as the durable queue (a transactional outbox).

- Accepting an event inserts the `events` row and one `deliveries` row per matching endpoint
  in a single transaction. The API returns 202 only after that transaction commits.
- Workers claim due rows with `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`,
  setting a lease (`locked_by`, `locked_until`). A reaper returns expired leases to
  `pending`.
- Redis is used only for rate limiting and per-endpoint concurrency counters. It is never the
  source of truth; losing Redis degrades limits but never loses events.
- The dispatcher sits behind an interface so a broker can replace it later.

## Consequences

- Exactly-once *acceptance* and at-least-once delivery with one datastore and no dual write.
- One fewer piece of infrastructure to run, monitor and pay for.
- The delivery queue is queryable with SQL, which makes the delivery log, DLQ and replay
  simple to build.
- Postgres carries queue load. Polling and row churn on `deliveries` need the
  `(status, next_attempt_at)` index, and vacuum must keep up. This is fine for the target of
  500 events/s on one instance but would become a bottleneck at much higher volumes.
- The claim query needs raw SQL because Prisma cannot express `SKIP LOCKED`.

## Alternatives considered

- **Redis Streams.** Fast, already in the stack, with consumer groups and pending-entry
  lists. Rejected as the source of truth: durability depends on AOF/fsync configuration, and
  it still needs a dual write with Postgres (or an outbox relay anyway).
- **RabbitMQ.** Mature acknowledgements, dead-lettering and delayed delivery via plugins.
  Rejected: an extra service to operate, delayed retries need a plugin or TTL tricks, and the
  dual-write problem remains without an outbox relay.
- **AWS SQS.** Managed, durable, with visibility timeouts and native DLQs. Rejected for v1:
  ties local development and the hackathon demo to AWS, the 15-minute delay cap does not fit
  a 6-hour retry schedule without re-enqueueing, and it still needs an outbox to avoid dual
  writes.
