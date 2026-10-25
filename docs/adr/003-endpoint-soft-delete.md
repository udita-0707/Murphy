# ADR 003: Soft-delete endpoints and cancel their unfinished deliveries

- Status: Accepted
- Date: 2026-10-25

## Context

Phase 1 implemented `DELETE /v1/endpoints/:id` as a hard delete with `ON DELETE CASCADE`,
which also erased the endpoint's deliveries and attempts. That destroys the delivery log a
developer needs when a customer asks "did you ever send me this event?", and it races with
the worker: a delivery that is in flight when its endpoint is deleted would vanish under the
worker.

## Decision

- `endpoints.deleted_at` marks a deleted endpoint. Deleted endpoints are excluded from list,
  get, update and fan-out, and every endpoint route returns 404 for them, exactly as if they
  never existed.
- A new delivery status, `cancelled`, means "the endpoint was deleted before this delivery
  finished". It is terminal.
- `DELETE` runs in one transaction: it sets `deleted_at` and moves that endpoint's `pending`
  and `in_flight` deliveries to `cancelled` (clearing the lease, setting `completed_at`).
  Finished deliveries (`succeeded`, `failed`, `dead`) keep their status.
- Deliveries and attempts of a deleted endpoint stay queryable through the event and
  delivery APIs.
- The worker's final write for an attempt is guarded by
  `status = 'in_flight' AND locked_by = <this worker>`. If the endpoint was deleted
  mid-request, the guard matches no row, so the delivery stays `cancelled`; the attempt itself
  is still logged.
- Replaying a `cancelled` delivery returns `409 endpoint_deleted`.
- A deleted endpoint cannot be restored through the API. Re-creating it gives a new id and a
  new signing secret.

## Consequences

- Delivery history survives endpoint deletion, which the DLQ, replay and the simulator's run
  reports depend on.
- No foreign-key cascade fires on delete, so deleting an endpoint is cheap regardless of how
  much history it has.
- Rows accumulate; the retention job (brief 3.3) will purge old deliveries and attempts, and
  can purge soft-deleted endpoints with no remaining history.
- Every endpoint query must filter `deleted_at IS NULL`. This is enforced in the repository
  layer and covered by integration tests.

## Alternatives considered

- **Hard delete with cascade** (phase 1): loses history and races with in-flight work.
- **Reuse `status = 'disabled'`**: conflates "temporarily switched off, deliveries parked"
  (410 handling, ADR 006) with "gone", and a disabled endpoint can be re-enabled.
- **Move deliveries to `dead`**: would put them in the DLQ and make them replayable, but
  there is nowhere to deliver them.
