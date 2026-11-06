# Murphy

> Murphy breaks your webhooks so production can't.

Murphy is a webhook delivery platform for hackathon teams, students and early-stage
developers. You send an event with one API call; Murphy signs it (Standard Webhooks), delivers
it to every matching endpoint, retries with backoff, parks permanent failures in a dead-letter
queue, logs every attempt, and lets you replay anything. Its simulator fires realistic payment, UPI
and booking webhooks at your handler, with duplicates, delays and reordering, and tells you whether it
survived.

## Quickstart (local)

Requirements: Node 20+, pnpm 10, Docker.

```sh
pnpm install
cp .env.example .env          # set POSTGRES_PASSWORD (and DATABASE_URL to match),
                              # MURPHY_ENCRYPTION_KEY=$(openssl rand -base64 32), MURPHY_MODE=local
pnpm infra:up                 # Postgres 16 on 127.0.0.1
pnpm db:migrate
pnpm db:seed                  # prints a project API key once: mk_...
pnpm dev                      # API on :3000 + delivery worker
```

### Demos start from a reset database

**Every demo must start from a fresh database.** A worker delivers whatever is pending, so
rows left over from earlier experiments would be sent to their (possibly real, external)
endpoint URLs as soon as the worker starts. Before a demo:

```sh
pnpm demo:reset   # docker compose down -v, infra up, migrate, seed (prints a new API key)
```

It refuses to run unless `MURPHY_MODE=local` is set and `DATABASE_URL` points to localhost.

Create an endpoint, start the dev receiver with its secret, and send an event:

```sh
export KEY=mk_...
curl -s -X POST localhost:3000/v1/endpoints -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"url":"http://127.0.0.1:4242/webhooks"}'
# -> {"id":"...","secret":"whsec_...", ...}   (the secret is shown only here)

RECEIVER_SECRET=whsec_... pnpm receiver --port 4242

curl -s -X POST localhost:3000/v1/events -H "Authorization: Bearer $KEY" \
  -H 'Idempotency-Key: order-42-paid' -H 'Content-Type: application/json' \
  -d '{"type":"payment.captured","payload":{"event":"payment.captured","id":"pay_1","amount":49900}}'
# -> 202 {"id":"<event id>","deliveries":1}
```

The receiver logs `signature=valid -> 200`. Try `pnpm receiver --fail 3 --status 503` to watch
retries, and see `tools/dev-receiver/README.md` for more.

## API

All routes are under `/v1` and need `Authorization: Bearer mk_...`. Errors look like
`{"error":{"code","message","request_id"}}`.

| Route                                                                  | Purpose                                                   |
| ---------------------------------------------------------------------- | --------------------------------------------------------- |
| `POST /events`                                                         | Accept an event. `Idempotency-Key` header required.       |
| `GET /events/:id`                                                      | Event with its deliveries                                 |
| `POST /endpoints`, `GET /endpoints`, `GET/PATCH/DELETE /endpoints/:id` | Endpoint management (delete is a soft delete)             |
| `GET /deliveries?status=&endpoint_id=&event_id=&cursor=`               | Delivery log, newest first, keyset-paginated              |
| `GET /deliveries/:id`                                                  | One delivery with every attempt                           |
| `POST /deliveries/:id/replay`                                          | Replay a succeeded, failed or dead delivery               |
| `POST /replay`                                                         | Bulk replay by status, endpoint and time range (max 1000) |
| `GET /dlq`, `POST /dlq/retry`                                          | Dead-letter queue and bulk retry (max 1000)               |

## Delivery semantics

**At-least-once, not exactly-once.** Murphy never loses an accepted event: the event and its
deliveries are written in one transaction before `POST /v1/events` returns 202, and a worker
that dies mid-delivery has its lease reaped and the delivery retried by another worker.
The flip side is that **your receiver can get the same webhook more than once**:

- a retry after a timeout, when your handler actually succeeded but answered too slowly;
- a worker killed after your receiver returned 2xx but before Murphy recorded it (the
  delivery is reaped after its 60 s lease and sent again);
- a replay you trigger from the API or dashboard.

Every copy carries the same `webhook-id` (`msg_<event id>`). **Deduplicate on `webhook-id`**:
store the ids you have processed and skip repeats. `webhook-timestamp` and the signature are
fresh on every attempt, so a replayed delivery still verifies within the 5-minute tolerance.

**Requests** are `POST` with the event payload, unchanged, as the JSON body and the headers
`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256>` over
`{id}.{timestamp}.{body}` with your endpoint secret, and `webhook-event-type` (the event's
type; not covered by the signature).

**Retries.** 2xx is success. Timeouts, network errors, 5xx, 408, 425 and 429 are retried after
5 s, 30 s, 2 m, 10 m, 30 m, 1 h, 3 h and 6 h (±20% jitter; `Retry-After` honoured up to 6 h),
then the delivery is dead. 400/401/403/404 are retried at most twice. 410 marks the delivery
dead and disables the endpoint (re-enable it with `PATCH {"status":"active"}`). Other
statuses, including redirects, are not retried.

**Ordering** is not guaranteed.

**Safety.** `MURPHY_MODE=hosted` (the default) only delivers to `https` URLs on public
addresses. `MURPHY_MODE=local` also allows `http`, localhost and LAN addresses for
development. Cloud metadata addresses are always blocked, DNS answers are pinned, and
redirects are never followed. In hosted mode the API also rejects obviously unsafe endpoint
URLs when they are created or changed (`400 endpoint_url_not_allowed`): non-https, credentials
in the URL, literal private, loopback or metadata IPs, and `localhost`.

## Simulator: does your webhook handler survive?

A scenario is a YAML file: entities, a timeline of events, faults and assertions. Murphy turns it into ordinary
deliveries, so the real worker signs, sends, retries and logs them.

```sh
pnpm dev                 # terminal 1: API and worker
pnpm demo:target         # terminal 2: a demo app with a naive and an idempotent handler
export MURPHY_API_KEY=mk_...

pnpm -s murphy run packages/simulator/scenarios/booking-duplicate-confirmation.yaml --target naive       # FAIL
pnpm -s murphy run packages/simulator/scenarios/booking-duplicate-confirmation.yaml --target idempotent  # PASS
```

The library in `packages/simulator/scenarios` has 8 scenarios. Payloads are provider-_style_, not exact copies, and every simulated event is
marked with a signed `_murphy` key.

**Test your own handler.** Mount `murphyTarget()` before `express.json()`, and report your result through its state route:

```ts
import { murphyTarget } from "@murphy/sdk";

app.use(
  "/webhooks/murphy",
  murphyTarget({
    secret: process.env.MURPHY_WEBHOOK_SECRET!,
    onEvent: (event) => myHandler(event.webhookId, event.type, event.payload),
    state: () => ({
      entities: {
        [reservation.id]: { state: reservation.status, effects: { booking: 1 }, balance_minor: 0 },
      },
    }),
  }),
);
```

```sh
# Create an endpoint for it once, and keep the secret it returns.
curl -s -X POST localhost:3000/v1/endpoints -H "Authorization: Bearer $MURPHY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://127.0.0.1:3001/webhooks/murphy","event_filter":["__murphy_simulation__"]}'

pnpm -s murphy run packages/simulator/scenarios/booking-cancel-before-confirm.yaml \
  --endpoint <id> --state-url http://127.0.0.1:3001/webhooks/murphy/state --label my-app
```

The `event_filter` keeps your ordinary events away from this endpoint. Localhost targets only work with `MURPHY_MODE=local`. The full contract is
in [packages/sdk/README.md](packages/sdk/README.md) and [docs/run-report-schema.md](docs/run-report-schema.md).

## Dashboard

The demo, in one command:

```sh
pnpm demo:reset   # prints a new API key
pnpm demo:stack   # builds the dashboard, then runs it with the API, demo target and control service
```

Open http://127.0.0.1:3100, paste the key, and choose **Run on both handlers** on a booking scenario: the same scenario on a naive and an idempotent handler, side by side,
with one figure from the two reports, such as "Booking effect 2 vs 1". Each result downloads as one HTML file that makes no external requests.

- `pnpm dev` also runs the dashboard, on the same port, without the chaos panel. Use one or the other, not both.
- **Chaos** kills a worker, restarts Postgres, or makes the demo target answer 500, with a live count of what happened to every accepted event. It refuses to run outside
  `MURPHY_MODE=local` with a local database (ADR 015). Retries are shortened on this machine, and the panel says so.
- **Light room** switches to a light theme for a bright room.
- GitHub login is optional. See `.env.example` and ADR 014.

The design is in `docs/design/direction.md`. Do not edit `apps/dashboard/test/fixtures`, which come from real runs (`scripts/make-fixtures.ts`).

## Reliability evidence

Murphy is tested by killing its workers, its API and its database while events are flowing, then
checking the result against logs that Murphy did not write. The latest results, what they prove and
what they do not prove are in [docs/chaos-report.md](docs/chaos-report.md).

```sh
pnpm chaos --seed 1001                       # about 2 minutes, needs Docker
pnpm chaos --seed 1001 --sabotage lost-event # damages the data on purpose, so this run must fail
pnpm load                                    # local ingestion baseline, not a benchmark
```

The exact claim: every delivery created for an accepted event is delivered, goes dead after retrying,
is cancelled by a delete, or stays parked on a disabled endpoint. An event accepted while an endpoint
is disabled, paused or deleted gets no delivery for that endpoint. Delivery is at-least-once, so
receivers must deduplicate on `webhook-id`.

## Status and scope notes

- **Retention** (deleting old attempts and payloads) is not built; it is planned for phase 6
  only if time allows, so local data grows until you run `pnpm demo:reset`.

- **Known flaky test:** `goes dead once attempts are exhausted` (`apps/worker/test/deliver.integration.test.ts`)
  failed once in an early full-suite run, at 5,040 ms, and the cause was never found. It did not recur in 119
  later runs (alone, under CPU load, and with its whole file). If it fails again, keep the full log. Do not run
  `pnpm install` during tests: replacing Prisma's engine breaks the run in progress, though that fails differently.

## Repository

```
apps/api              Express API
apps/worker           delivery worker: fair claim, SSRF-safe sender, retries, reaper
packages/core         signing, retry policy, canonical JSON
packages/db           Prisma schema, migrations, repository layer, delivery queue
packages/simulator    provider profiles, YAML scenarios, compiler, reports, scenario library
packages/sdk          murphyTarget(), so your own handler can be tested by a scenario
packages/cli          murphy run
tools/dev-receiver    local receiver that verifies signatures and simulates failures
tools/chaos           chaos harness, report and load baseline
tools/demo-target     demo app with a naive and an idempotent handler
docs/adr              architecture decision records
docs/handover         phase handover notes
```

`pnpm typecheck`, `pnpm lint` and `pnpm test` (needs Docker for Testcontainers) run across
the workspace. Design decisions are in `docs/adr`.
