# ADR 010: Chaos harness method and compressed retry time

- Status: Accepted
- Date: 2026-11-05

## Context

Murphy claims that no accepted event is lost. Testing that means real processes, real crashes and
checks that do not simply ask the database about itself. The real retry schedule runs for over 10
hours (5 s up to 6 h, 9 attempts), so a test run cannot wait for a delivery to exhaust it.

## Decision

**Compressed time.** `WORKER_RETRY_SCHEDULE_MS` replaces the schedule with comma-separated
milliseconds. The worker refuses to start with it set unless `MURPHY_MODE=local`, so a deployment
cannot have its receivers' retry budget burned in seconds. The harness keeps the same number of
retries and the normal jitter, so the exhaustion logic runs unchanged. Leases need no override: a
2 s request timeout with an 18 s lease passes the existing safety check.

**Independent sources.** Every invariant names the sources it compares:

- client log: what the load generator sent and every 202 it received
- control log: what the harness itself did (kills, deletes, disables)
- receiver log: what a separate receiver process saw, written on receipt
- database: final state
- audit history: every row change, recorded by a trigger installed only for the run

**Runs must be able to fail.** A run where the faults had no visible effect is reported as
vacuous and fails. Sabotage modes damage the database during a run, and the matching invariant must
fail. Other invariants have failing fixtures in unit tests.

**Reproducibility.** A seed fixes the workload, the fault plan and every receiver decision. Real
processes and the OS scheduler are not deterministic, so the same seed gives the same inputs but
not identical counts.

## Consequences

- Latency in chaos reports reflects compressed retries and injected faults. It is not a benchmark.
- One more worker setting, which fails closed outside local mode.
- `pnpm chaos` needs Docker and takes minutes, so it stays out of `pnpm test`. Only its unit tests
  run there.

## Alternatives considered

- **Pulling `next_attempt_at` forward with SQL during a run:** needs no production code, but it
  writes to the very state under test and can mask scheduling bugs.
- **Running with the real schedule:** a run would take over 10 hours.
