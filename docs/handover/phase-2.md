# Phase 2 handover: delivery engine

Date: 2026-10-26. Branch `main`, local commits only (not pushed). Author for every commit:
`udita-0707 <153092248+udita-0707@users.noreply.github.com>`, no trailers.

## What was built

Murphy now delivers what it accepts. A worker claims due deliveries fairly across projects,
validates the target against SSRF, signs each attempt (Standard Webhooks), sends it with a
pinned IP and bounded time and body, logs every attempt, and applies the retry policy. A
reaper recovers deliveries from workers that died. The API exposes the delivery log, single
and bulk replay, and the dead-letter queue. A dev receiver verifies signatures and simulates
failures locally.

## Commits

| Step | Commit    | Message                                                                       |
| ---- | --------- | ----------------------------------------------------------------------------- |
| 1    | `b59723a` | feat(db): soft-delete endpoints and cancel their unfinished deliveries        |
| 2    | `6830cff` | feat(worker): claim loop with per-project fair claiming and graceful shutdown |
| 3    | `7b2607e` | feat(worker): SSRF guard with DNS pinning and bounded requests                |
| 4    | `995f6cd` | feat(worker): execute deliveries with signing, attempt log and retry policy   |
| 5    | `5463056` | feat(worker): reap expired leases with a poison guard                         |
| 6    | `af198dc` | feat(api): delivery log, replay and DLQ endpoints                             |
| 7    | `605dc58` | feat(tools): add dev receiver that verifies signatures and simulates failures |
| 8    | (this)    | docs: phase 2 README, ADR 001 update and handover                             |

New ADRs: 003 soft delete and `cancelled`, 004 claim and fairness, 005 SSRF protection,
006 webhook-id and retry policy, 007 lease reaper and poison guard. ADR 001 now documents the
at-least-once duplicate case.

New migrations: `endpoint_soft_delete` (`endpoints.deleted_at`, `cancelled` status),
`pending_claim_index` (partial index, migration-only), `delivery_client_error_count`,
`delivery_reap_count`.

## Approved decisions, as implemented

1. **Fairness:** one `LATERAL` claim. For each project with due work it takes up to
   `WORKER_PROJECT_CAP` of that project's oldest due rows (`FOR UPDATE SKIP LOCKED`), then
   fills the batch round-robin by rank up to `WORKER_BATCH_SIZE`. A partial index on
   `(project_id, next_attempt_at)` for pending rows backs it. Only deliveries of active,
   non-deleted endpoints are claimed. Tested:
   project A with 1000 due rows and project B with 1, B is in the first batch of 10.
2. **410:** delivery `dead`, endpoint `disabled`; its other deliveries stay `pending` and are
   skipped by the claim; `PATCH status=active` releases them (tested).
3. **MURPHY_MODE:** defaults to `hosted` (https, public unicast only). `local` adds http,
   loopback, RFC 1918 and IPv6 ULA. Metadata (all of `169.254.0.0/16`, `fd00:ec2::254`) is
   blocked in both. The line in `.env.example` is commented out so a copied example cannot
   switch a deployment to local.
4. **Reaper:** reaps are logged as `lease_expired` and do not count; the 4th and later reap of
   the same delivery counts as an attempt with normal backoff, and goes dead when exhausted.
5. **Replay** resets `attempt_count`, `client_error_count` and `reap_count`; `attempt_no`
   keeps increasing.
6. **400/401/403/404:** at most 2 retries since the last replay, via a new
   `client_error_count` column (noted in ADR 006).
7. **At-least-once duplicates** documented in `README.md` and ADR 001, and seen live in DoD 3.
8. **Nothing was cut:** bulk `POST /v1/replay` is in. The rotate-secret stretch was skipped as
   agreed.

Additions: `webhook-id = msg_<event id>`, stable across retries and replays; timestamp and
signature fresh on every attempt (test: a delivery replayed an hour later with a fake clock
verifies, while the original signature would be rejected as too old). SSRF tests cover
decimal, hex and octal IPv4, IPv4-mapped IPv6 literals and `good.com@127.0.0.1`. Config load
fails fast unless lease > request timeout + 15 s.

## Checks

Run on 2026-10-26 from the repo root:

- `pnpm typecheck --force`: 6/6 tasks successful.
- `pnpm lint`: exit 0. `pnpm format:check`: clean.
- `pnpm test --force`: **291 passed, 0 failed.**

| Package                | Files | Tests |
| ---------------------- | ----- | ----- |
| `@murphy/core`         | 5     | 61    |
| `@murphy/api`          | 4     | 66    |
| `@murphy/worker`       | 8     | 154   |
| `@murphy/dev-receiver` | 1     | 10    |

Phase 1 ended at 98 tests; phase 2 adds 193.

## End-to-end check (manual, compose Postgres, `MURPHY_MODE=local`)

Setup: `pnpm infra:up`, then `pnpm db:migrate` ("No pending migrations to apply"). I started
the API and the worker, created the endpoint `http://127.0.0.1:4242/webhooks`, and started
the dev receiver on port 4242 with that endpoint's secret. Secrets are redacted below.

**1. Signed, verified delivery with a logged attempt.**

```
POST /v1/events (Idempotency-Key: dod-1) -> {"id":"55b62d3b-…","deliveries":3}
[receiver] id=msg_55b62d3b-… signature=valid -> 200
GET /v1/deliveries/3efe335c-…  status succeeded, attempt_count 1, last_status_code 200,
  created 20:08:52.192Z, completed 20:08:52.448Z
  attempts[0]: attempt_no 1, duration_ms 16, response 200 {"ok":true},
  request_headers: user-agent Murphy-Webhooks/0.1, webhook-id msg_55b62d3b-…,
  webhook-timestamp 1792958932, webhook-signature v1,…
```

The event fanned out to 3 deliveries because the demo project still had two endpoints from
the phase 1 check (see Notes).

**2. Receiver fails 3 times, then succeeds.** `POST /_control {"fail":3,"status":503}`.
Instead of waiting for the backoff I **pulled `next_attempt_at` forward with psql** after each
failure; there is no dev override in the code.

```
after attempt 1: pending|1|503|due in 4.3 s
after attempt 2: pending|2|503|due in 34.4 s
after attempt 3: pending|3|503|due in 125.5 s
after attempt 4: succeeded|4|200
delivery_attempts: 1 503, 2 503, 3 503, 4 200 (four distinct webhook-timestamps)
[receiver] … signature=valid -> 503 (2 more failures queued)
[receiver] … signature=valid DUPLICATE -> 503 (1 more failures queued)
[receiver] … signature=valid DUPLICATE -> 503
[receiver] … signature=valid DUPLICATE -> 200
```

**3. SIGKILL mid-flight.** Receiver `delayMs` 8000, one worker running.

```
before kill: in_flight|0|…:28503:3841dc1e|lease left 58 s
kill -9 28496 28503   (killed at 20:10:37), new worker started
after the receiver answered the dead socket: in_flight|0|…:28503:3841dc1e
worker B: reaped expired leases [{previousWorker …:28503…, reapCount 1, outcome pending}]
deliveries: succeeded | attempt_count 1 | reap_count 1 | 200 | completed 20:11:38
delivery_attempts: 1 lease_expired, 2 200
[receiver] 20:10:42 id=msg_b903d7d4-… signature=valid -> 200
[receiver] 20:11:38 id=msg_b903d7d4-… signature=valid DUPLICATE -> 200
```

Redelivered about 61 s after the kill (60 s lease plus reaper interval). The receiver saw the
event twice: the at-least-once case documented in the README.

My first attempt at this step did not kill the worker (a quoting mistake in my shell
command), and the original worker completed the delivery normally. I noticed, and redid it
with the process ids checked; the output above is from the redo.

**4. Replay from the API.**

```
POST /v1/deliveries/3efe335c-…/replay -> 202 {"status":"pending","attempt_count":0,…}
attempts: 1 20:08:52 200 ts 1792958932; 2 20:11:53 200 ts 1792959113 (same webhook-id)
[receiver] 20:11:53 id=msg_55b62d3b-… signature=valid DUPLICATE -> 200
GET /_control -> {"received":9,"valid":9,"invalid":0,"duplicates":5}
```

**5. `pnpm dev`** starts both: `@murphy/worker:dev: worker started … mode local` and
`@murphy/api:dev: Murphy API listening on http://localhost:3000`. No wiring change was
needed; Turbo runs every package with a `dev` script.

## How to verify

```sh
cd /Users/udita/Desktop/Murphy
pnpm install
pnpm typecheck && pnpm lint && pnpm test          # Docker must be running

pnpm infra:up && pnpm db:migrate
pnpm db:seed                                      # save the mk_... key
pnpm dev                                          # terminal 1: API + worker (.env has MURPHY_MODE=local)

export KEY=mk_...
curl -s -X POST localhost:3000/v1/endpoints -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"url":"http://127.0.0.1:4242/webhooks"}'
RECEIVER_SECRET=whsec_... pnpm receiver --port 4242          # terminal 2

curl -s -X POST localhost:3000/v1/events -H "Authorization: Bearer $KEY" \
  -H 'Idempotency-Key: try-1' -H 'Content-Type: application/json' \
  -d '{"type":"payment.captured","payload":{"id":"pay_1","amount":49900}}'
curl -s "localhost:3000/v1/deliveries?limit=5" -H "Authorization: Bearer $KEY"

curl -s -X POST localhost:4242/_control -d '{"fail":3,"status":503}'   # then send another event
docker exec murphy-postgres-1 psql -U murphy -d murphy \
  -c "update deliveries set next_attempt_at = now() where status = 'pending'"   # skip the wait

curl -s -X POST localhost:3000/v1/deliveries/<id>/replay -H "Authorization: Bearer $KEY"
curl -s localhost:3000/v1/dlq -H "Authorization: Bearer $KEY"
```

## Notes and deviations

- **Real outbound request during the check.** When the worker first started against the
  compose database, it delivered the pending deliveries left from the phase 1 check, including
  one real `POST https://example.com/webhooks` (IANA's reserved example domain; it answered
  405, so that delivery is `dead`). I then soft-deleted the two phase 1 demo endpoints
  (`https://example.com/webhooks`, `http://localhost:4242/hooks`). Their history stays in
  the database.
- **Endpoint secret in a local log.** Starting the receiver with `--secret` made pnpm echo it
  into a local scratch log, and it appeared in my session output. It belongs to a throwaway
  local endpoint and was not sent anywhere else. The receiver README now recommends
  `RECEIVER_SECRET`.
- **Body format:** the request body is the event `payload` as-is, with no
  `{type, timestamp, data}` envelope (ADR 006). This keeps simulated provider payloads
  identical to the real ones.
- **URLs with userinfo** (`user:pass@`, `good.com@…`) are rejected in both modes.
- **`failed` status** is unused: retries wait as `pending` with `attempt_count > 0`, and
  every terminal failure is `dead`.
- **Replay to a disabled endpoint** is allowed; the delivery waits, parked, until the endpoint
  is re-activated.
- **Partial index** `deliveries_pending_project_due_idx` exists only in migrations (Prisma
  cannot model it). `prisma migrate dev` did not try to drop it in this phase.
- **Shutdown aborts** are logged as an attempt with `error = 'worker_shutdown'`, and the lease
  is released without counting an attempt.

## Open questions

1. **Event type outside the payload?** Add a `webhook-event-type` header (small), or switch
   to the Standard Webhooks envelope?
2. **`localhost` and IPv6.** The connection is pinned to the first validated address. In the
   check, an old endpoint registered as `http://localhost:4242/…` resolved to `::1` first and
   got `ECONNREFUSED`, because the receiver listens on IPv4. Options: try each validated
   address in turn, prefer IPv4 in local mode, or keep documenting `127.0.0.1`.
3. **Validate URLs when an endpoint is created?** The API accepts any http(s) URL; blocked
   targets are only caught at delivery time (and go `dead`). Rejecting `http://` and private
   IP literals at create time in hosted mode would give faster feedback.
4. **Retention job** (brief 3.3) is not built yet; attempts and soft-deleted endpoints
   accumulate.
5. **Redis** is still unused (rate limits and per-endpoint concurrency are phase 5).

## Not done (by agreement)

Signing-secret rotation endpoint, phase 3 (simulator), anything on the v1 cut list. Nothing
pushed.
