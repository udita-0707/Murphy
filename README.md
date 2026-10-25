# Murphy

> Murphy breaks your webhooks so production can't.

Murphy is a webhook delivery platform for hackathon teams, students and early-stage
developers. You send an event with one API call; Murphy signs it (Standard Webhooks), delivers
it to every matching endpoint, retries with backoff, parks permanent failures in a dead-letter
queue, logs every attempt, and lets you replay anything. A fintech event simulator (Razorpay-,
UPI- and KYC-style scenarios with injected faults) is coming in the next phase.

## Quickstart (local)

Requirements: Node 20+, pnpm 10, Docker.

```sh
pnpm install
cp .env.example .env          # set POSTGRES_PASSWORD (and DATABASE_URL to match),
                              # MURPHY_ENCRYPTION_KEY=$(openssl rand -base64 32), MURPHY_MODE=local
pnpm infra:up                 # Postgres 16 + Redis 7 on 127.0.0.1
pnpm db:migrate
pnpm db:seed                  # prints a project API key once: mk_...
pnpm dev                      # API on :3000 + delivery worker
```

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
redirects are never followed.

## Repository

```
apps/api              Express API
apps/worker           delivery worker: fair claim, SSRF-safe sender, retries, reaper
packages/core         signing, retry policy, canonical JSON
packages/db           Prisma schema, migrations, repository layer, delivery queue
tools/dev-receiver    local receiver that verifies signatures and simulates failures
docs/adr              architecture decision records
docs/handover         phase handover notes
```

`pnpm typecheck`, `pnpm lint` and `pnpm test` (needs Docker for Testcontainers) run across
the workspace. Design decisions are in `docs/adr`.
