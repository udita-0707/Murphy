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
