# ADR 011: The simulator uses the real engine, and says which faults need the target's help

- Status: Accepted
- Date: 2026-11-06

## Context

The simulator fires faulty webhook sequences at a handler. If it had its own delivery path, a passing run
would say nothing about the engine, and the engine's signing, retries and attempt log would go unused.

Some faults cannot come from the sender. Murphy can send late, out of order or twice, but it cannot make
someone else's server answer 503.

## Decision

A run only writes ordinary `events` and `deliveries` rows, with future `next_attempt_at` values. The delivery
path (`claim`, `createDeliveryHandler`, `sendWebhook`, `decideOutcome`, the reaper) has no simulator code.

| Fault                 | How it happens                                                                                               | Realised by |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | ----------- |
| `delay_ms`            | A later `next_attempt_at`                                                                                    | Engine      |
| `reorder_before`      | This step's row is due before the named step's. The logical order stays legal                                | Engine      |
| `duplicate`           | A second delivery row for the same event and endpoint. `webhook-id` comes from the event, so it is identical | Engine      |
| `drop_then_redeliver` | The target answers the first arrival with 503, and the worker retries on its real schedule                   | Target      |
| `respond_with`        | The target answers the listed statuses, then behaves normally                                                | Target      |

**Target faults are instructions in a signed block.** Every simulated event has one top-level `_murphy` key
(`readMurphyBlock` in `@murphy/core`), and only simulated events have it. It marks the event as simulated and lists
any forced responses. `murphyTarget()` in `@murphy/sdk` obeys it. Because the block is inside the signed body, nobody
can forge an instruction without the endpoint's secret.

**A fault that did not happen makes the run `errored`, never passed.** Each fault is checked against
`delivery_attempts` after the run. A target that ignores the block is reported as not cooperating. This is the same rule
as a vacuous chaos run (ADR 010).

**Logical order and send order are separate.** The provider's state machine sees the logical order, which must be legal.
Faults only change when each event is sent. So a reorder is "a legal sequence that arrives out of order", which is what
happens in production.

**Effects are net outcomes, not counts of events seen.** A reservation cancelled after confirming holds 0 bookings, in
any arrival order. Otherwise a correct handler that ignores a confirm arriving after a cancel would look wrong.

**Simulated events reach one endpoint.** A run inserts rows for its own endpoint and does not use `accept`, so events never
fan out to a project's real endpoints. Run endpoints have an event filter no ordinary event matches.

## Consequences

- Scenarios wait for real retries (5 s, then 30 s), so one can list at most two forced responses.
- `duplicate` cannot be combined with a response fault: both copies share one `webhook-id`, so the target could not tell
  which arrival a forced response is for.
- `respond_with: 410` is rejected, because it would really disable the endpoint. Statuses that are not retried are
  rejected too, because the handler would never see the event.
- Reordering depends on the gap between steps being longer than a worker's poll. If timing cancels a reorder, the run is
  `errored`, not wrongly passed.
- Scenarios against a target without `murphyTarget()` can only use engine faults.
- Simulated dead deliveries appear in the DLQ. They are marked, not hidden.

## Alternatives considered

- **A fault proxy in front of the target:** works without touching the target, but needs URL rewriting, another process and
  about three times the code.
- **A fault flag the worker obeys:** puts simulator code in the delivery path, and the attempt log would record responses
  that never happened.
- **A control channel to the target:** needs registration and state in both places. A signed block needs neither.
