# ADR 009: Lock endpoint rows when creating or reviving deliveries

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

## Consequences

- No delivery is left waiting on a deleted endpoint by these paths.
- Accepts on the same endpoint do not block each other (`FOR SHARE` is shared). They briefly block,
  and are blocked by, an update of that endpoint row, such as a `PATCH` or a 410 disabling it.
  Endpoint updates are rare, so this is not expected to matter; the phase 6 load test can confirm.
- Many concurrent share locks on a row use a MultiXact, a small cost at high ingest rates.
- A disable or pause racing with `accept` is unaffected in outcome, and was already safe: a row
  created just before the status change simply parks.

## Alternatives considered

- **A sweeper that cancels pending deliveries of deleted endpoints:** leaves a window, adds a
  background job, and treats the symptom.
- **SERIALIZABLE isolation for these transactions:** needs retry handling on every caller for a
  race on a rare operation.
- **`FOR UPDATE` on the endpoint:** would make all accepts on an endpoint run one at a time.
