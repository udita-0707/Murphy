# ADR 009: Lock endpoint rows when creating, reviving or claiming deliveries

- Status: Accepted
- Date: 2026-11-05

## Context

Deleting an endpoint (ADR 003) marks it deleted, then cancels its `pending` and `in_flight`
deliveries. The claim skips deleted endpoints. So a delivery that becomes `pending` after that
sweep is never claimed and never cancelled: it waits forever, which breaks "every delivery reaches
a terminal state".

Three writers could do that, each reproduced by a test that holds its transaction open at the
racing moment (`apps/worker/test/delete-race.integration.test.ts`):

- `accept`: read the endpoint as live, and its uncommitted row was invisible to the sweep.
- `replay` and `bulkReplay`: the row was still `dead` during the sweep, so it was skipped.

The foreign key does not help: its check takes `FOR KEY SHARE`, which does not conflict with an
update of `deleted_at`, a non-key column.

## Decision

`accept`, `replay` and `bulkReplay` lock the endpoint rows they depend on with `FOR SHARE`, which
conflicts with the delete's update, so the two are serialised under READ COMMITTED:

- If the delete holds the row first, the writer waits, re-checks the row, sees `deleted_at` and
  creates or revives nothing for that endpoint.
- If the writer holds it first, the delete waits. Its sweep is a later statement with a new
  snapshot, so it sees the committed row and cancels it.

### The claim (added after chaos seed 2002)

The claim read `e.status = 'active'` without locking the endpoint, so a disable could commit during
the claim and a delivery that should have parked was sent. Chaos seed 2002 caught this through the
audit history: one delivery, inside the 6 ms the disable took to commit.

The claim now uses `FOR SHARE OF e SKIP LOCKED`:

- If a claim holds the row first, a disable waits for it, so once a disable returns no later claim
  can take that endpoint's work.
- If a disable or delete holds the row first, the claim skips that endpoint until its next poll.

**The guarantee covers new claims only.** A delivery already `in_flight` when a disable commits is
still sent, and its result is recorded normally. Disabling an endpoint does not recall a request
that a worker has already claimed, and that request may reach the receiver after the `PATCH`
returns. Stopping traffic immediately would need the worker to re-check the endpoint just before
sending, and even that could not recall a request already on the wire. A delete is different: it
cancels the row, so the attempt is logged but its result is ignored (ADR 003). The request itself
may still be sent.

`SKIP LOCKED` matters. Soft delete locks the endpoint first and then cancels its deliveries. A plain
`FOR SHARE` would make the claim wait for the endpoint while holding delivery rows, while the delete
waits for those rows and holds the endpoint, which is a lock-order deadlock. With `SKIP LOCKED` the
claim never waits behind a disable or delete.

## Consequences

- No delivery is left waiting on a deleted endpoint by these paths.
- Accepts on the same endpoint do not block each other (`FOR SHARE` is shared). They briefly block,
  and are blocked by, an update of that endpoint row, such as a `PATCH` or a 410 disabling it.
  Endpoint updates are rare, so this is not expected to matter; the phase 6 load test can confirm.
- Every claim takes a share lock on the endpoints it touches. Measured on 2026-11-06 with
  `tools/chaos/src/claim-latency.ts`: the real claim against a copy without the lock, in alternating
  rounds on one Postgres in Docker on a laptop, with 30,000 pending deliveries and 9 endpoints. These
  are the ranges across three runs, with no endpoint being changed during them:

  | Scenario                       | p50 without  | p50 with     | p50 change     | p95 change   |
  | ------------------------------ | ------------ | ------------ | -------------- | ------------ |
  | One claimer                    | 6.7–7.0 ms   | 6.8–7.1 ms   | +0.2% to +0.4% | +1% to +14%  |
  | Three claimers                 | 8.1–10.7 ms  | 8.2–10.8 ms  | +0.5% to +1.7% | -8% to +11%  |
  | Three claimers, live ingestion | 24.8–33.4 ms | 23.8–28.5 ms | -15% to -2%    | -32% to +10% |

  So the cost at p50 is about 0.02 to 0.15 ms where it can be seen at all, and it is lost in noise
  under ingestion. p95 changes sign between runs, so no p95 cost can be claimed or ruled out. This
  covers claim time only, not a production-sized database, so the phase 6 load test should still
  look at it.

- A `PATCH` on an endpoint waits for claims in progress, which are short, and a claim skips an
  endpoint being changed until its next poll.
- A delete and a 410 response disabling the same endpoint can still deadlock (one holds the endpoint
  and wants the delivery, the other the reverse). This is not new. Postgres aborts one of them after
  about a second: an aborted delete returns a 500 and can be retried, and an aborted attempt is
  recovered by the reaper. Nothing is lost.
- Many concurrent share locks on a row use a MultiXact, a small cost at high ingest rates.
- A disable or pause racing with `accept` is unaffected in outcome, and was already safe: a row
  created just before the status change simply parks.

## Alternatives considered

- **A sweeper that cancels pending deliveries of deleted endpoints:** leaves a window, adds a
  background job, and treats the symptom.
- **SERIALIZABLE isolation for these transactions:** needs retry handling on every caller for a
  race on a rare operation.
- **`FOR UPDATE` on the endpoint:** would make all accepts on an endpoint run one at a time.
