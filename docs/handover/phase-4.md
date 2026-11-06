# Phase 4 handover: fintech and booking simulator

Date: 2026-11-06, ahead of the 8 Nov time box. Branch `main`, local commits only (not pushed). Author for every commit:
`udita-0707 <153092248+udita-0707@users.noreply.github.com>`, no trailers.

## Outcome

Phase 4 is done. `murphy run` shows FAIL on the naive handler and PASS on the idempotent one, on all 8 library scenarios. Nothing from
the approved scope was cut.

**The simulator has no delivery path of its own.** `git diff 666fc40 HEAD` is empty for `deliver.ts`, `worker.ts`, `policy.ts`,
`reaper.ts`, `net/send.ts` and `queue.ts`. A run only writes ordinary `events` and `deliveries` rows, due in the future.

Read a real report first: [docs/sample-run-report.md](../sample-run-report.md).

## Results

| Check                                                                 | Result                                                                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Demo scenarios at real speed, real processes                          | **80 of 80 as expected**: 20 each of 2 scenarios on 2 handlers, slowest 5.9 s. The reorder gap did not need widening |
| All 8 scenarios, both handlers, real worker and HTTP, compressed time | 16 of 16: naive fails on the intended assertion, idempotent passes                                                   |
| `murphy run` end to end                                               | 14 tests, real API, worker, target and CLI processes                                                                 |
| Full suite, uncached                                                  | 718 tests passed on the final commit. 3 earlier uncached runs at 717 also passed                                     |
| Property test, 500 runs                                               | Passed on the final engine, 91 s                                                                                     |
| Chaos seed 2002                                                       | PASS on the final code (`.chaos/phase4/seed-2002`)                                                                   |
| Typecheck, lint, format                                               | Clean                                                                                                                |

Test counts: worker 271, simulator 106, api 104, core 95, chaos 63, cli 35, demo-target 15, sdk 13, dev-receiver 10, demo-reset 6.

**Only the 2 demo scenarios were repeated at real speed.** `booking-cancel-after-payment` also ran once at real speed. The other 5 have only run at compressed time. Run them before relying on them in the demo.

## Flaky test (item 0)

**Not reproduced, cause still unknown.** `goes dead once attempts are exhausted` ran 120 times in about 20 of the 30 minutes: 50 alone, 50 under
8 CPU burners, and 20 runs of its whole file under load. One failed, and that was my own `pnpm install` replacing Prisma's engine while it ran (it
failed in 11 ms, unlike the original 5,040 ms). So 119 of 119 otherwise. As you instructed, there is a known-flaky note in the README.
Installing during tests is now noted in `CLAUDE.md`.

## How each fault is realised

| Fault                 | Realised by | How                                                                                       | Proof, from `delivery_attempts` |
| --------------------- | ----------- | ----------------------------------------------------------------------------------------- | ------------------------------- |
| `delay_ms`            | Engine      | A later `next_attempt_at`                                                                 | First attempt not early         |
| `reorder_before`      | Engine      | This step's row is due before the named step's                                            | Attempts really inverted        |
| `duplicate`           | Engine      | A second row for the same event, so the same `webhook-id`                                 | Both copies got a 2xx           |
| `drop_then_redeliver` | **Target**  | `murphyTarget()` answers 503 from the signed `_murphy` block, and the real worker retries | 503, then a 2xx                 |
| `respond_with`        | **Target**  | The same, with the listed statuses                                                        | Statuses match the list         |

Every report states which is which. A fault that did not happen makes the run `errored`, never passed. ADR 011 has the reasoning.

## Approved decisions, as implemented

1. **Signed `_murphy` block:** simulated events only, one top-level key, documented in `docs/run-report-schema.md`.
2. **Finisher in the worker:** `apps/worker/src/run-finisher.ts`. The CLI soft-deletes a run endpoint only after the report is stored, and a test
   checks that order. It never deletes an endpoint it did not create.
3. **UPI `expired -> success`:** allowed, as a late bank confirmation.
4. **Additive migration:** nullable columns and a partial unique index. A test applies it on top of rows written under the old schema and checks they
   are unchanged.
5. **`murphyTarget()` in `packages/sdk`:** `tools/demo-target` imports it. The README and `packages/sdk/README.md` show how to test your own handler, and
   an end-to-end test runs that flow with a separate small handler.

## Your own hackathon project

```sh
pnpm dev     # MURPHY_MODE=local
export MURPHY_API_KEY=mk_...
curl -s -X POST localhost:3000/v1/endpoints -H "Authorization: Bearer $MURPHY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://127.0.0.1:3001/webhooks/murphy","event_filter":["__murphy_simulation__"]}'
# Put the returned secret in your app, mounted with murphyTarget().

pnpm -s murphy run packages/simulator/scenarios/booking-cancel-before-confirm.yaml \
  --endpoint <id> --state-url http://127.0.0.1:3001/webhooks/murphy/state --label my-app
```

Your `state` function must report `effects` as net outcomes, under the id in `_murphy.entity_id`. See `docs/run-report-schema.md`.

## Commits

| Step | Commit    | Message                                                                                    |
| ---- | --------- | ------------------------------------------------------------------------------------------ |
| 0    | `e936bb4` | docs: known-flaky note, after 119 runs did not reproduce it                                |
| 1    | `ca10cef` | feat(simulator): payments, UPI and booking profiles with seeded payloads                   |
| 2    | `f0c3c6d` | feat(simulator): YAML scenarios with validation, and a compiler to run plans               |
| 3    | `7542fa3` | feat(db): scenario and run repositories, with an additive migration                        |
| 4    | `40e66b2` | feat(sdk): murphyTarget() middleware, and a demo target with naive and idempotent handlers |
| 5    | `03b0b64` | feat(worker): finish simulator runs, with evaluation and a versioned report                |
| 6    | `858ebea` | feat(api): scenario and run routes, tenant-scoped, with JSON and markdown reports          |
| 7    | `07fe105` | feat(simulator): library of 8 scenarios, each proven against both handlers                 |
| 8    | `f1cd0e4` | feat(cli): murphy run, with a live timeline, exit codes and a reliability script           |
| 8    | `7b15e3a` | fix(cli): tag only the copy or attempt that a fault really applies to                      |
| 8    | `7b9fc91` | test: own-handler flow end to end, and the migration over existing rows                    |
| 9    | (this)    | docs: phase 4 handover, report schema, README and CLAUDE.md                                |

Step 0 landed after steps 1 and 2 because the loops ran in the background. New ADRs: 011 simulator on the real engine, 012 finisher and report schema.

New migration: `20261106120000_simulator_runs`.

## How to verify

```sh
cd /Users/udita/Desktop/Murphy
pnpm install
pnpm typecheck && pnpm lint
pnpm exec turbo run test --force                   # Docker must be running; about 1m45

# The definition of done, by hand. Needs MURPHY_MODE=local in .env.
pnpm demo:reset                                    # prints a new key
pnpm dev                                           # terminal 1: API and worker
pnpm demo:target                                   # terminal 2
export MURPHY_API_KEY=mk_...

S=packages/simulator/scenarios
pnpm -s murphy run $S/booking-duplicate-confirmation.yaml --target naive       # FAIL, exit 1
pnpm -s murphy run $S/booking-duplicate-confirmation.yaml --target idempotent  # PASS, exit 0
pnpm -s murphy run $S/booking-cancel-before-confirm.yaml --target naive --report /tmp/naive.md  # FAIL, exit 1
pnpm -s murphy run $S/booking-cancel-before-confirm.yaml --target idempotent   # PASS, exit 0

curl -s localhost:3000/v1/scenarios -H "Authorization: Bearer $MURPHY_API_KEY" | head -c 300

pnpm --filter @murphy/cli reliability --runs 20    # about 8 minutes; 80 runs on their own stack
pnpm chaos --seed 2002                             # engine regression check
```

I ran each piece through the tests' real-process stack, not through compose and `pnpm dev`. The by-hand path above has not been run as written, so try it
once before the demo.

## Scope cuts

**From your phase 4 scope: none.**

**From the brief, out by your scope or the approved plan:**

- KYC, and the 15-scenario target (8 instead)
- `slow_response` and `burst` faults, and the `all_deliveries_return_2xx_within` assertion
- Invalid-signature and replayed-timestamp scenarios
- CLI `login`, `tunnel` and `replay`
- Public share link (phase 5), record-and-replay, add-a-provider by configuration
- Response faults for targets you cannot edit, since the proxy was rejected

## Deviations and limits

- **`pnpm -s murphy`, not a bare `murphy`.** I removed the placeholder `bin`, which pointed at a `dist` that nothing builds. Without `-s`, pnpm prints its own
  error line after every intended FAIL, which would look bad in a demo.
- **A run needs a state endpoint.** All five assertions read the target's state, so `state_url` is required on `POST /v1/runs`.
- **`respond_with` takes failing statuses only**, at most two, and only ones the worker retries. The plan's example `[503, 200]` is written `[503]`: later arrivals are
  normal anyway. A 2xx would let a delivery succeed without the handler ever seeing it.
- **`--target` keeps the demo target's secrets in memory.** Restarting `pnpm demo:target` only affects runs in progress.
- **After `pnpm demo:reset`, restart the API** or `GET /v1/scenarios` has no built-ins. `murphy run <file>` is unaffected, because it uploads the file. The reset stops the
  database anyway, so `pnpm dev` needs restarting regardless.
- **One of my tests was too weak.** My first "planted bug" test passed for the wrong reason, because the bug was harmless. It now dedupes on the wrong key, and
  `booking-partial-refund` catches it: "Balance is 350000, expected 300000".
- **The property test found a bug in the naive handler.** A payment failing before authorisation left its hold at -1 with no fault injected. Fixed, so a naive FAIL always comes from the
  fault. "Both handlers match the state machine when nothing goes wrong" is now a property test.

**What the results do not show:**

- **I wrote both handlers.** The library shows the checks can tell them apart, not that any real app is safe. Worth careful wording in the demo.
- **Verdicts rely on the target's own state report.** A wrong state endpoint gives a wrong result. Reports say so. The proof test compares the demo target's arrival log with
  `delivery_attempts`, but that check does not apply to other targets.
- **The idempotent handler is demo code.** Its dedupe is an in-memory set in one process. A real one needs a unique constraint, written in the same transaction as the effect. Reports say a pass
  does not cover concurrent delivery on several servers.
- **Not tested against a real public endpoint in hosted mode.** Hosted mode is tested only for refusing localhost targets and state URLs.
- **`GET /state` in `murphyTarget()` has no authentication.** The SDK README says not to mount it in production.
- **Simulated dead deliveries appear in the DLQ** and can be bulk-replayed. They are marked, not hidden. The dashboard may want to filter on this.
- **No limit on concurrent runs per project.** A run has at most 50 steps, but nothing limits how many start. Worth a look before a public deployment.
- **Timing.** A reorder needs the gap between steps to exceed the worker's poll. 80 of 80 here, with 11 other containers running. If a demo machine is much slower, the run shows `errored`, not a wrong
  verdict, and `step_gap_ms` in the YAML widens it.

**Environment:** Docker was not running when I started, so I opened Docker Desktop, which also started your other containers. The nine exited `postgres:16` containers noted in phase 3 may still
be there. 15 GB free at the end.

## Next

Phase 5 is the dashboard. It should read `docs/run-report-schema.md`, and show `errored` differently from `failed`. Nothing has been started on it.
