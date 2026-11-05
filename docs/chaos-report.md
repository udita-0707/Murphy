# Murphy chaos report

**3 of 3 seeded runs passed.** Across them, Murphy accepted 9,000 events while its workers, API and database were being killed. Every event was stored, and every delivery created for one was delivered, went dead after retrying, was cancelled by a delete, or stayed parked on a disabled endpoint.

**The limit on that claim:** an event accepted while an endpoint is disabled, paused or deleted gets no delivery for that endpoint, and does not get one if the endpoint is re-enabled later. That happened 5,289 times across these runs, because the runs take endpoints out of service on purpose. It is intended behaviour, and the `deliveries` count in the 202 shows it.

This file is generated from real runs by `tools/chaos/src/summary.ts`. To check it yourself, run
`pnpm chaos --seed 1001`, which needs Docker and takes a few minutes. Counts will differ a
little, because process timing is not fixed by a seed.

## How to read this

Murphy promises that an event it has accepted is never lost. To test that, this harness runs the
real API, real workers and a separate flaky receiver against a real Postgres, sends thousands of
events, and breaks things on purpose while they are being delivered: it kills workers and the API
with SIGKILL, kills and restarts Postgres, and has the receiver fail in several ways. When things
go quiet, it compares what each independent party recorded.

**Where the evidence comes from.** A check that compares the database with itself proves little,
so each invariant names its sources:

- **Client log:** what the load generator sent and every 202 it actually received.
- **Control log:** what the harness did on purpose (kills, deletes, disables).
- **Receiver log:** what a separate receiver process saw, written the moment each request arrived.
- **Database:** the final state of Murphy's tables.
- **Audit history:** every change to every delivery row during the run, recorded by database
  triggers that are installed only for chaos runs.

## What was proven

In each passing run, after all the faults:

- Every event that got a 202 is in the database, unchanged. _Compares: client log vs database._
- An Idempotency-Key gives one event, whatever the retries. _Compares: client log vs database._
- The deliveries count in each 202 matches the rows in the database. _Compares: client log vs database._
- No accepted event is lost: each expected delivery reached the receiver, went dead after trying, or is parked or cancelled on purpose. _Compares: client log + control log vs receiver log vs database._
- Every delivery marked succeeded really got a signed 2xx at the receiver. _Compares: database vs receiver log._
- Every receipt traces to a sent event: valid signature, same payload, right tenant, right id. _Compares: receiver log vs client log._
- All deliveries are terminal, or parked on purpose. _Compares: database + control log + receiver log._
- Zero deliveries in flight, zero leases left over. _Compares: database only._
- Only legal transitions and no counter going backwards, across every change in the run. _Compares: audit history._
- An idempotent receiver deduplicating on webhook-id processes each logical message exactly once. _Compares: receiver log vs client log._

## What this does not prove

- **Disabled and paused endpoints get no new deliveries.** An event accepted while an endpoint is
  disabled, paused or deleted creates no delivery for it, and is not sent when the endpoint is
  re-enabled. This is intended behaviour, shown in the 202's `deliveries` count. So the precise
  claim is: every delivery _created_ for an accepted event reaches a terminal state or is parked.
  The "no delivery, by design" count above says how often this happened.
- **One machine.** All processes and Postgres ran on one laptop, with no network between them.
- **Process crashes, not power loss.** Postgres was killed and recovered from its write-ahead log,
  but the operating system and disk kept running, so this does not test what `fsync` protects
  against when the power goes.
- **No network partitions, and the receiver was never killed.**
- **Compressed time.** Retries used a schedule of about 20 seconds instead of over 10 hours, with
  the same number of attempts. Timing bugs that only appear over hours would not show here.
- **Replay is not exercised here.** It is covered by the model-based property tests
  (`apps/worker/test/state-machine.property.test.ts`) instead.
- **Redis is not tested** because nothing uses it (the brief's "drop Redis" fault does not apply).
- **Latency is measured under chaos**, on a laptop, with faults injected. It is not a benchmark.
- **A seed fixes the inputs, not the outcome.** The workload, fault plan and every receiver decision
  are the same for a seed, but process timing is not, so counts vary between runs of one seed.

## The three runs

| Seed | Result | Events accepted | Deliveries | Succeeded | Dead | Cancelled | Parked | In flight | Duplicates (naive receiver) | Leases reaped | Control endpoint p50 / p95 |
| ---- | ------ | --------------- | ---------- | --------- | ---- | --------- | ------ | --------- | --------------------------- | ------------- | -------------------------- |
| 1001 | PASS   | 3,000           | 6,066      | 5,244     | 582  | 236       | 4      | 0         | 814                         | 44            | 35 / 1,412 ms              |
| 2002 | PASS   | 3,000           | 6,196      | 5,409     | 564  | 216       | 7      | 0         | 779                         | 64            | 33 / 993 ms                |
| 3003 | PASS   | 3,000           | 6,105      | 5,318     | 536  | 247       | 4      | 0         | 871                         | 54            | 34 / 711 ms                |

`Dead`, `Cancelled` and `Parked` are expected. Those endpoints were built to always fail, were
deleted on purpose, or were disabled on purpose. Invariant I4 checks each one against the logs.

## Can these checks fail?

Yes. In these runs the harness deliberately damaged the database while the run was going on, the
way a real bug would, and the matching invariant has to catch it. Every invariant also has failing
fixtures in `tools/chaos/test/verify.test.ts`.

| Sabotage       | What it did                                                                                               | Invariant that must fail | Outcome            | Others that also failed |
| -------------- | --------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------ | ----------------------- |
| `lost-event`   | deleted acknowledged event 2f498c4a-31b2-42fd-ae76-f060ff199ef8                                           | I1                       | failed, as it must | I3, I4                  |
| `fake-success` | marked delivery ecafc51e-9191-459d-86c2-73c7fc9d7fb8 succeeded, on an endpoint that only ever answers 500 | I5                       | failed, as it must | I4, I9                  |

## Bugs these checks found

Phase 3 found three real bugs in the delivery engine. All three are fixed, each with a regression
test.

| Bug                                                                              | Found by                                     | What went wrong                                                                                                                                           | Fix                                                           |
| -------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| A worker's late write could end a newer lease and move `attempt_count` backwards | Model-based property test, seed `1990363018` | A worker stalled past its lease, was reaped, and claimed the same row again. Its old task then passed the write guard, which only checked the worker's id | `ceb4609`, ADR 008: a claim token on every lease              |
| A delivery could wait forever on a deleted endpoint                              | Targeted race tests                          | `accept`, `replay` or `bulkReplay` made a row `pending` just after the delete's sweep. Nothing would claim or cancel it                                   | `fed3729`, ADR 009: lock the endpoint row                     |
| A delivery could be sent just after a disable returned                           | Chaos seed 2002, invariant I9                | The claim read the endpoint as active while the disable was committing. One delivery in 6,000 went out inside the 6 ms commit                             | `b1ff321`, ADR 009: `FOR SHARE OF e SKIP LOCKED` in the claim |

Before the fix, only seed 2002 showed the third bug, because it depends on timing; the other seeds
passed. It was caught through the audit history, not the final state of the database.

After that fix, a delivery already `in_flight` when a disable commits is still sent, and may reach the
receiver after the `PATCH` returns. The guarantee covers new claims only (ADR 009).

## Every run, including the ones that did not pass

A report showing only passes would hide how the harness got here.

| Run                                                        | Result                            | What happened                                                                                                                          |
| ---------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Seed 1, 600-event smoke run                                | VACUOUS                           | Postgres restarts overlapped and no rows were cancelled, so some faults had no effect. Fixed the harness                               |
| Seed 1001, first full run                                  | PASS                              | Before the claim fix                                                                                                                   |
| Seeds 1001, 2002 and 3003                                  | 1001 and 3003 PASS, 2002 **FAIL** | 2002 found the third bug above                                                                                                         |
| Sabotage control from that set                             | Harness failure                   | The laptop slept for 8 minutes during the run, which broke timing. Fixed by keeping the machine awake and counting drain time in polls |
| One further set                                            | Stopped by hand                   | A failing test and a lint error had been committed by mistake. Fixed and restarted                                                     |
| Seeds 1001, 2002 and 3003, and both controls (shown above) | All as expected                   | After the claim fix                                                                                                                    |
| Seeds 2002, 4004 and 5005, as an extra check               | All PASS                          | After the claim fix                                                                                                                    |

The runs shown above were made at commit `42879b9`. Later commits change tests, documents and tools,
not the engine.

## What the claim's lock costs

A separate measurement compared the real claim with a copy without the lock, on 30,000 pending
deliveries. The lock added about 0.02 to 0.15 ms at p50 where it could be seen at all. The p95 changed
sign between runs, so no p95 cost can be claimed or ruled out. ADR 009 has the table, and
`tools/chaos/src/claim-latency.ts` reproduces it.

# Full detail: seed 1001

## Invariants

| #   | Invariant                                                                                                                            | Sources compared                                     | Checked | Violations | Result |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ------- | ---------- | ------ |
| I1  | Every event that got a 202 is in the database, unchanged                                                                             | client log vs database                               | 3,000   | 0          | PASS   |
| I2  | An Idempotency-Key gives one event, whatever the retries                                                                             | client log vs database                               | 6,000   | 0          | PASS   |
| I3  | The deliveries count in each 202 matches the rows in the database                                                                    | client log vs database                               | 3,000   | 0          | PASS   |
| I4  | No accepted event is lost: each expected delivery reached the receiver, went dead after trying, or is parked or cancelled on purpose | client log + control log vs receiver log vs database | 7,881   | 0          | PASS   |
| I5  | Every delivery marked succeeded really got a signed 2xx at the receiver                                                              | database vs receiver log                             | 5,244   | 0          | PASS   |
| I6  | Every receipt traces to a sent event: valid signature, same payload, right tenant, right id                                          | receiver log vs client log                           | 13,351  | 0          | PASS   |
| I7  | All deliveries are terminal, or parked on purpose                                                                                    | database + control log + receiver log                | 6,066   | 0          | PASS   |
| I8  | Zero deliveries in flight, zero leases left over                                                                                     | database only                                        | 6,066   | 0          | PASS   |
| I9  | Only legal transitions and no counter going backwards, across every change in the run                                                | audit history                                        | 26,938  | 0          | PASS   |
| I10 | An idempotent receiver deduplicating on webhook-id processes each logical message exactly once                                       | receiver log vs client log                           | 5,244   | 0          | PASS   |
| I11 | A naive receiver with no deduplication processed 814 duplicates                                                                      | receiver log                                         | 0       | 0          | INFO   |

- **I4:** Stable endpoints: expected deliveries come from the plan and the client log alone. Endpoints that change state: an event sent during the change may correctly get no delivery, so the row is taken from the database and its outcome checked against the receiver and control logs.
- **I8:** This compares the database with itself, because it is a statement about database state. I4 and I5 are the independent checks.
- **I9:** Recorded by triggers inside each writing transaction, so it includes states the final snapshot cannot show.
- **I10:** A set keyed on webhook-id is exactly-once by construction, so the real check is that each client-generated logical id and endpoint only ever arrived under one webhook-id. If Murphy changed the id on a retry, this would fail.
- **I11:** Reported, not pass or fail: delivery is at-least-once, so duplicates are expected. This is why receivers must deduplicate.

## Run

| Setting                                              | Value                                           |
| ---------------------------------------------------- | ----------------------------------------------- |
| Seed                                                 | 1001                                            |
| Plan hash (same seed and options give the same hash) | 5a21b6e522012e1a                                |
| Started                                              | 2026-11-05T18:24:01.054Z                        |
| Duration                                             | 94 s, of which draining 28 s                    |
| Workers                                              | 3                                               |
| Retry schedule (compressed)                          | 200, 500, 1000, 1500, 2000, 3000, 4000, 5000 ms |
| Request timeout / lease                              | 2000 ms / 18000 ms                              |
| Postgres fsync                                       | on                                              |
| Postgres synchronous_commit                          | on                                              |
| Postgres server_version                              | 16.15 (Debian 16.15-1.pgdg13+2)                 |

## Faults injected

Times are seconds from the start of the load.

| At     | Action                    | Target    | Detail    |
| ------ | ------------------------- | --------- | --------- |
| 12.2 s | SIGKILL API               |           | pid 56669 |
| 13.2 s | Restart API               |           |           |
| 14 s   | SIGKILL worker            | w1.0      | pid 56718 |
| 16.4 s | Start replacement worker  | w1.1      |           |
| 18.7 s | Kill and restart Postgres |           |           |
| 20.9 s | Disable endpoint          | c-toggled |           |
| 24.9 s | SIGKILL worker            | w0.0      | pid 56717 |
| 27.1 s | Start replacement worker  | w0.1      |           |
| 30.5 s | Disable endpoint          | c-parked  |           |
| 37.3 s | Delete endpoint           | c-deleted |           |
| 38.1 s | Re-enable endpoint        | c-toggled |           |
| 41.3 s | Kill and restart Postgres |           |           |
| 46.6 s | SIGKILL API               |           | pid 56965 |
| 47.5 s | SIGKILL worker            | w0.1      | pid 57250 |
| 48 s   | Restart API               |           |           |
| 49.6 s | Start replacement worker  | w0.2      |           |

## Did the faults have an effect?

A fault that hits nothing proves nothing. If any line here is "no", the run is reported as vacuous
and fails.

| Effect                                          | Seen | Evidence                                                                                                                               |
| ----------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Worker kills abandoned real work                | yes  | 29 deliveries were in flight on the 3 killed workers and were reaped; 15 more were reaped from workers that survived but lost Postgres |
| Postgres really restarted                       | yes  | 3 distinct pg_postmaster_start_time values, 2 restarts planned                                                                         |
| The client felt the outages                     | yes  | 724 failed requests, retried with the same key                                                                                         |
| Receiver answered 5xx                           | yes  | 7292 times                                                                                                                             |
| Receiver answered slowly                        | yes  | 542 times                                                                                                                              |
| Receiver hung past the timeout                  | yes  | 208 times                                                                                                                              |
| Receiver processed, then answered 500           | yes  | 398 times                                                                                                                              |
| Receiver processed, then dropped the connection | yes  | 179 times                                                                                                                              |
| Receiver answered 410                           | yes  | 1 times                                                                                                                                |
| Duplicates occurred                             | yes  | 814 duplicates                                                                                                                         |
| Some deliveries went dead                       | yes  | 582 dead                                                                                                                               |
| Some deliveries parked                          | yes  | 4 parked                                                                                                                               |
| Some deliveries were cancelled                  | yes  | 236 cancelled                                                                                                                          |

Expired leases by worker, including workers that survived but lost Postgres mid-delivery: w0.0: 11, w0.1: 9, w1.0: 9, w1.1: 10, w2.0: 5.

## Counts

| What                                             | Count  |
| ------------------------------------------------ | ------ |
| Events planned                                   | 3,000  |
| Events that got a 202                            | 3,000  |
| Events the client gave up on                     | 0      |
| Events in the database                           | 3,000  |
| Failed client requests, then retried             | 724    |
| Deliberate resends with the same key             | 150    |
| 202s answered from an existing event             | 150    |
| Deliveries                                       | 6,066  |
| No delivery, by design (endpoint out of service) | 1,815  |
| Attempt rows logged                              | 13,351 |
| Requests that reached the receiver               | 13,351 |
| Expired leases reaped                            | 44     |
| Delivery row changes in the audit history        | 26,938 |

Final state of deliveries, by what the endpoint was doing. `pending` here means parked.

| Endpoint behaviour | succeeded | dead | cancelled | pending | in_flight | failed |
| ------------------ | --------- | ---- | --------- | ------- | --------- | ------ |
| always_500         | 0         | 353  | 0         | 0       | 0         | 0      |
| control            | 1,161     | 0    | 0         | 0       | 0         | 0      |
| deleted            | 0         | 228  | 236       | 0       | 0         | 0      |
| flaky              | 771       | 0    | 0         | 0       | 0         | 0      |
| gone               | 150       | 1    | 0         | 0       | 0         | 0      |
| lost_ack           | 1,082     | 0    | 0         | 0       | 0         | 0      |
| parked             | 379       | 0    | 0         | 4       | 0         | 0      |
| slow               | 1,161     | 0    | 0         | 0       | 0         | 0      |
| toggled            | 540       | 0    | 0         | 0       | 0         | 0      |

## Duplicates

A receiver with no deduplication processed **814** duplicates. A receiver
that deduplicates on `webhook-id` processed each message once (I10).

| Why the message was sent again                                                     | Duplicates |
| ---------------------------------------------------------------------------------- | ---------- |
| receiver processed it, then answered 500                                           | 398        |
| receiver processed it, but answered after the worker's timeout                     | 208        |
| receiver processed it, then dropped the connection                                 | 179        |
| receiver answered 2xx, but Murphy did not record it (worker killed, Postgres down) | 29         |

## Delivery latency

From the client's first send to the receiver's log, so Murphy's own timestamps are not involved.
Measured during the faults with compressed retries, so this is not a benchmark.

| Measure                           | Count | p50   | p95      |
| --------------------------------- | ----- | ----- | -------- |
| First arrival, control endpoint   | 1,161 | 35 ms | 1,412 ms |
| First arrival, all endpoints      | 6,065 | 36 ms | 1,410 ms |
| First clean 2xx, control endpoint | 1,161 | 35 ms | 1,412 ms |
| First clean 2xx, all endpoints    | 5,244 | 47 ms | 2,235 ms |
