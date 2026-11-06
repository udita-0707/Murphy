# ADR 012: The worker finishes runs, and reports have a versioned schema

- Status: Accepted
- Date: 2026-11-07

## Context

A run needs something to notice that it is over, read the target's final state, decide the verdict and
store a report. Phase 5's dashboard and share page will read those reports, so their shape has to hold still.

## Decision

**The worker finishes runs**, in an interval next to the reaper (`apps/worker/src/run-finisher.ts`). The worker is
already the only process that makes outbound requests through the SSRF guard, so the API stays free of them. Reading
the target's state follows the same rules as a delivery: the guard, a pinned address, no redirects, and bounded time
and size. A run survives a CLI crash, because the CLI only watches.

Several workers can do this at once. The report is stored with a guard on `status = 'running'`, so the first write
wins. A crash mid-pass leaves the run for the next pass.

**A run has three outcomes:**

- `passed`: every assertion held.
- `failed`: at least one assertion did not hold. This is the useful result: the handler has a bug.
- `errored`: the run was not a fair test and proves nothing. A delivery never got through, the run passed its deadline,
  the target's state could not be read, or a planned fault did not happen.

Assertions are checked against the target's reported state, and faults against `delivery_attempts`. The expected state
comes from the provider's state machine, not from a value written by hand, and a scenario whose `final_state` disagrees
with it is rejected when it is parsed.

**The report is versioned** (`schema_version: 1`, `runReportSchema` in `packages/simulator/src/report.ts`, documented in
`docs/run-report-schema.md`). Reports are validated before being stored. Changing a field's meaning or removing one needs a
new version. Adding an optional field does not. Reports never contain request headers, because those hold signatures.

**A run stores its compiled plan**, so later edits to a scenario cannot change what an old run meant.

## Consequences

- One more query every second per worker. It uses an index on status, and running runs are few.
- A run's verdict waits for its last delivery, including real retries.
- The verdict depends on what the target reports about itself. The report says so in its limits.
- A run whose stored plan cannot be read stays `running` and logs an error on each pass. Only tampering can cause this.

## Alternatives considered

- **Finish runs in the API on a timer:** the API would need outbound requests and the SSRF guard.
- **Let the CLI finish runs:** a run started through the API, or a crashed CLI, would never finish.
- **Evaluate on read, when someone asks for the report:** the first reader's request would make outbound calls, and the
  target's state may have changed by then.
