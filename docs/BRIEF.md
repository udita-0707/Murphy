# HookLab: Problem Brief, PRD and Tech Spec

*Working name. Webhook delivery infrastructure with a fintech event simulator, built for hackathon teams, students and early-stage developers.*

Track: Backend. Author: Udita. Version 0.1, October 2026.

---

# Part 1: Problem Brief

## 1.1 Problem

Almost every payments, SaaS or marketplace product depends on webhooks: Razorpay tells you a payment was captured, a KYC provider tells you a check finished, GitHub tells you a PR merged. Webhooks are easy to demo and very hard to get right.

Students and hackathon teams hit three concrete problems:

1. **They cannot test webhook handlers properly.** Real providers only send clean, in-order, single deliveries in test mode. Production behaviour is different: events arrive late, twice, out of order, or not at all. Student projects work on demo day and break the first time a retry or duplicate arrives. Handlers that double-credit a wallet or double-ship an order are the usual result.
2. **They cannot easily send webhooks reliably.** Any team that builds its own platform (a marketplace, a bot, a small SaaS) ends up writing an ad hoc `fetch` call with no signing, no retries, no logs and no replay. When a customer says "I never got the event", there is nothing to inspect.
3. **Local development is painful.** Testing needs public tunnels, copy-pasted payloads from provider docs, and manual re-triggering. Teams lose hours in a 24 to 48 hour hackathon.

Established tools exist (Svix, Hookdeck, Webhook.site, provider sandboxes, generic mock servers), but they are aimed at funded teams, are priced or scoped for production, or only show static happy-path payloads. Nothing targets student and hackathon teams with a free, simple tool that makes failure behaviour easy to test.

## 1.2 Why it matters

- Idempotency and out-of-order handling are the most common correctness bugs in fintech integrations, and the ones interviewers ask about.
- Hackathons and student projects are a large, recurring audience that is reachable through college clubs, Discord communities and event organisers.
- Learning to handle failure is a skill, and a tool that makes failure easy to practise has educational value on top of practical value.

## 1.3 Proposed solution

HookLab has two connected halves that share one delivery engine.

**A. Reliable webhook delivery platform (the engine).** A developer sends an event to HookLab through one API call. HookLab signs it, delivers it to one or more registered endpoints, retries with exponential backoff, parks permanent failures in a dead-letter queue, keeps a full delivery log, and lets the developer replay any event. Per-tenant rate limits and fair scheduling keep one noisy tenant from starving others.

**B. Fintech event simulator (the entry point).** A developer registers their own endpoint and picks a scenario, for example *UPI collect request that times out after 90 seconds* or *payment captured webhook delivered twice, then a refund event arriving before the capture*. HookLab generates realistic provider-shaped payloads (Razorpay-style, UPI-style, KYC-style) and fires them with configurable delay, duplication, reordering and failure. The developer sees exactly how their handler behaved and gets a pass or fail report.

The simulator gives people a reason to try HookLab on day one with no production traffic. The delivery platform is the long-term product and the main source of technical depth.

## 1.4 Target users

| Segment | Description | Main need |
| --- | --- | --- |
| Primary: hackathon and student teams | College students building payment, e-commerce, wallet or bot projects in 24 to 48 hour events or semester projects | Free, zero-setup way to test and send webhooks; failure behaviour without reading provider docs |
| Secondary: early-stage developers | Indie developers and small startups building their first integration | Reliable outbound delivery without building it; delivery logs and replay |
| Tertiary: educators and event organisers | Instructors, club leads and hackathon organisers | Reusable scenarios and a pass/fail report to evaluate integrations |

Non-target users: enterprises needing SLAs, compliance certifications or high-volume production traffic.

## 1.5 Scope

**In scope for v1**

- Multi-tenant webhook delivery with signing, retries, dead-letter queue, replay and delivery logs
- Fintech simulator with stateful payment, refund and UPI-collect lifecycles, and a scenario scripting format
- Web dashboard (endpoints, events, deliveries, scenarios, reports)
- REST API, API keys, a TypeScript SDK and a CLI for local tunnelling
- Verification libraries and a test-assertion helper for CI
- Per-tenant rate limits and fair scheduling
- Published load-test and failure-injection results

**Out of scope for v1**

- Real money movement or real provider credentials
- Multi-region deployment
- Billing and payments for HookLab itself
- Inbound webhook ingestion from third parties (possible later)
- Enterprise SSO and compliance certifications

## 1.6 Success metrics

| Metric | Target by end of semester |
| --- | --- |
| Real users (accounts that deliver at least 10 events) | 25 or more, from at least 3 colleges or communities |
| Hackathon or project adoptions | At least 2 teams using it in a real event or project |
| Delivery correctness | Zero lost events and zero duplicate-state bugs across chaos tests (at-least-once with idempotency keys) |
| Throughput | Sustained 500 events/s on a single modest instance, with published p50/p95/p99 delivery latency |
| Fairness | A tenant flooding 50x its quota does not raise other tenants' p95 latency by more than 20 percent |
| GitHub consistency | Commits on at least 5 days per week, with issues and PRs referencing milestones |
| Documentation | Public docs site plus at least 2 technical blog posts |

---

# Part 2: Product Requirements Document (PRD)

## 2.1 Personas

**Aarav, hackathon participant (primary).** Second-year student, 36 hours to build a donation wallet app. Uses Razorpay test mode. Needs to know his handler does not credit a donation twice. Has no time to read docs or set up infrastructure.

**Meera, final-year student (primary).** Building a semester project, a small marketplace with order and payment events. Wants to show a demo that survives failure and wants evidence for her report.

**Rohan, indie developer (secondary).** Building a small SaaS that notifies customers' systems of events. Wants to stop hand-rolling delivery code and wants customers to see delivery logs.

**Prof. Iyer, instructor (tertiary).** Wants to assign a task ("make your handler idempotent") and receive a pass/fail report per team.

## 2.2 Core user journeys

**Journey 1: test my handler (simulator).**

1. Sign in with GitHub, create a project.
2. Paste an endpoint URL, or run `hooklab tunnel 3000` to get a public URL for localhost.
3. Pick a scenario from the library (for example "Payment captured twice").
4. Click Run. HookLab delivers the scripted events.
5. View the timeline: what was sent, when, the response codes, and the assertions ("handler returned 2xx", "final state correct").
6. Get a shareable report and a CI snippet to repeat it.

**Journey 2: send reliable webhooks (platform).**

1. Create an application and register customer endpoints, with a signing secret per endpoint.
2. Send an event with `POST /v1/events`.
3. HookLab delivers, retries and logs. The developer checks the delivery log, and replays failures in one click.

**Journey 3: educator assignment.**

1. Create a scenario pack and share an invite link.
2. Each team registers an endpoint and runs the pack.
3. The educator sees a table of pass/fail results per team.

## 2.3 Functional requirements

Priority: P0 must ship, P1 should ship, P2 stretch.

### Delivery platform

| ID | Requirement | Priority |
| --- | --- | --- |
| D1 | Create applications, endpoints and event type filters; per-endpoint signing secret with rotation | P0 |
| D2 | `POST /v1/events` with required `Idempotency-Key`; returns 202 once the event is durably stored | P0 |
| D3 | HMAC-SHA256 signed payloads with timestamp, protecting against replay | P0 |
| D4 | Retries with exponential backoff and jitter on non-2xx or timeout; a configurable maximum attempt count | P0 |
| D5 | Dead-letter queue for exhausted deliveries, visible in the dashboard | P0 |
| D6 | Delivery log: every attempt with request, response status, latency and truncated body | P0 |
| D7 | Replay of a single event or a time range of failed events | P0 |
| D8 | Automatic endpoint disabling after sustained failure, with a recovery check and notification | P1 |
| D9 | Per-tenant rate limits and fair scheduling | P1 |
| D10 | Optional per-endpoint ordering (FIFO by key) | P1 |
| D11 | SSRF protection: block private, loopback and link-local addresses for outbound delivery in hosted mode | P0 |
| D12 | Delivery to a CLI tunnel (local development) | P1 |

### Simulator

| ID | Requirement | Priority |
| --- | --- | --- |
| S1 | Provider profiles that generate realistic payload shapes for payments (Razorpay-style), UPI collect and KYC | P0 |
| S2 | Stateful lifecycles: payment `created, authorized, captured, refunded/failed`; UPI collect `pending, success/failed/expired` | P0 |
| S3 | Scenario scripting in YAML: delays, duplicates, reordering, drops, status-code faults, slow responses | P0 |
| S4 | Built-in scenario library of at least 15 scenarios, tagged by difficulty | P0 |
| S5 | Assertions: handler returned 2xx within N seconds, handler was idempotent (the same event did not cause duplicate effects), and optionally a callback to query the handler's final state | P1 |
| S6 | Shareable run report with a public link | P1 |
| S7 | Record-and-replay: import a captured payload sequence as a scenario | P2 |
| S8 | Add a provider by configuration (JSON/OpenAPI-derived templates), no code | P2 |

### Developer experience

| ID | Requirement | Priority |
| --- | --- | --- |
| X1 | GitHub sign-in, project creation in under 60 seconds | P0 |
| X2 | TypeScript SDK (`send`, `verifySignature`) and a Python verification helper | P0 |
| X3 | CLI: `login`, `tunnel`, `run <scenario>`, `replay` | P1 |
| X4 | Test helper for CI (`await hooklab.expectHandlerSurvives(scenario)`) | P1 |
| X5 | Public docs site with quickstarts for Express, FastAPI and Next.js | P0 |

### Dashboard

| ID | Requirement | Priority |
| --- | --- | --- |
| U1 | Endpoint management, event list, delivery timeline per event | P0 |
| U2 | Scenario picker, run view with live timeline | P0 |
| U3 | DLQ view with bulk replay | P0 |
| U4 | Usage and quota view | P1 |

## 2.4 Non-functional requirements

| Area | Requirement |
| --- | --- |
| Reliability | At-least-once delivery. No acknowledged event is lost on a worker or database restart. |
| Latency | p95 time from accepted event to first delivery attempt under 1 second at 500 events/s |
| Scalability | Workers scale horizontally; no single in-process queue |
| Security | Secrets hashed or encrypted at rest; signed payloads; SSRF protection; per-tenant isolation in every query |
| Observability | OpenTelemetry traces across API, queue and worker; structured logs; metrics for queue depth, attempt outcome and latency |
| Usability | A new user reaches a first successful delivery in under 5 minutes |
| Cost | Runs on a single small VM plus managed Postgres and Redis within a student budget |

## 2.5 Free tier and future business model

- Free: 5,000 events/month, 7 days of log retention, 3 endpoints per project, public scenarios.
- Future paid (not built in v1): team workspaces, 30-day or longer retention, private scenario packs, CI integrations, higher limits.
- Educational: free elevated limits for verified classes and hackathon organisers. Hackathon organisers are the best early distribution channel.

## 2.6 Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Scope too large for one semester | Strict P0 list; one queue, one language, one database; no multi-region |
| Simulated payloads drift from real providers | Label them "Razorpay-style" rather than exact; version provider profiles; accept community fixes by pull request |
| Abuse (using HookLab to attack third-party URLs) | SSRF blocklist, per-tenant rate limits, endpoint ownership verification, optional allowlist-only mode for free tier |
| Low adoption | Pre-commit to outreach: 3 hackathons or college clubs by week 8; ship the CLI and docs early |
| Correctness bugs in retries and ordering | Chaos and property tests from the first milestone, results published |

## 2.7 Milestones

The plan maps to the course checkpoints (problem statement, GitHub consistency, backend assessment, documentation).

| Phase | Weeks | Deliverables |
| --- | --- | --- |
| 0. Setup | 1 | Repo, monorepo, CI, schema v1, problem statement submitted |
| 1. Core engine | 2 to 4 | Event ingestion, worker, signing, retries, delivery log; first end-to-end delivery |
| 2. Reliability | 5 to 6 | DLQ, replay, endpoint disabling, SSRF protection, chaos tests |
| 3. Simulator | 7 to 9 | Provider profiles, lifecycles, scenario DSL, 15 scenarios, run reports |
| 4. Dashboard and DX | 10 to 11 | Dashboard, SDK, CLI, docs site |
| 5. Scale and fairness | 12 to 13 | Rate limits, fair scheduling, load tests, published benchmark |
| 6. Launch | 14 to 16 | Outreach to hackathons and clubs, feedback fixes, two blog posts, final report |

---

# Part 3: Technical Specification

## 3.1 Architecture overview

&#91;embedded content: HookLab architecture · 7 components\]

Accepting an event and creating its deliveries is one database transaction; workers then pull due rows, so a crash after acceptance delays delivery but never loses it.

**Components**

| Component | Responsibility | If it fails |
| --- | --- | --- |
| API service | Authenticates, validates, enforces idempotency and rate limits, stores the event and its deliveries in one transaction | Clients retry with the same Idempotency-Key; nothing accepted is lost |
| Delivery workers | Claim due deliveries, sign and send, log each attempt, schedule retries or dead-letter | A reaper returns expired leases to pending and the delivery is retried |
| PostgreSQL | Holds all durable state: events, deliveries (the outbox queue), attempts, endpoints, runs | Delivery pauses; accepted events stay on disk and resume after restart |
| Redis | Ingestion rate limits and per-endpoint concurrency counters | Limits degrade to per-instance values; no event is lost |
| Simulator | Compiles a scenario into scheduled deliveries with injected faults and evaluates its assertions | The run fails and can be repeated; real deliveries are unaffected |
| SDK, CLI, dashboard | Developer-facing clients of the API | No effect on delivery |

**Life of an event**

1. The client calls `POST /v1/events` with an `Idempotency-Key`; the API checks auth and the project's rate limit.
2. The API writes the event and one delivery row per matching endpoint in a single transaction, then returns 202.
3. A worker claims due rows with `SKIP LOCKED` under a lease, taking a bounded share per project.
4. The worker applies SSRF checks and the endpoint's concurrency cap, signs the payload and sends it.
5. A 2xx marks the delivery succeeded; a retryable failure sets `next_attempt_at` from the backoff schedule; exhausted deliveries become dead and appear in the DLQ.
6. Every attempt is logged with its trace id, and any delivery can be replayed from the dashboard or API.

A simulator run takes the same path: it inserts scheduled deliveries, with fault flags, at step 2 instead of the API.

**Key design decisions**

1. **Postgres as the durable queue (transactional outbox).** Accepting an event writes the event and its delivery rows in a single transaction. Workers claim rows with `SELECT ... FOR UPDATE SKIP LOCKED`. This gives durability and exactly-once *acceptance*, avoids a dual-write problem between a database and a broker, and keeps operations simple. Redis is used only for rate limiting and fairness, never as the source of truth. A queue like Kafka or SQS can replace the dispatcher later behind an interface.
2. **At-least-once delivery with consumer-side idempotency.** Exactly-once delivery over HTTP is not possible. Each delivery carries a stable `webhook-id` so receivers can deduplicate, and the SDK provides a dedup helper.
3. **The simulator reuses the delivery engine.** A scenario run compiles into a set of scheduled deliveries with injected faults. This keeps one code path and means simulator bugs are delivery bugs, which are tested thoroughly.
4. **Monorepo.** `pnpm` plus Turborepo, with packages for `api`, `worker`, `simulator`, `dashboard`, `sdk`, `cli` and shared `core` types.

## 3.2 Technology stack

| Layer | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript (Node 20) | Matches current stack; shared types across packages |
| API | Express with Zod validation | Familiar and quick |
| Database | PostgreSQL 16 with Prisma, raw SQL for the queue claim query | Prisma for CRUD; `SKIP LOCKED` needs raw SQL |
| Cache and limits | Redis | Token buckets, locks |
| Dashboard | Next.js with Tailwind | Fast to build; server-rendered pages |
| Auth | GitHub OAuth for users; hashed API keys for programmatic access | Students all have GitHub |
| Observability | OpenTelemetry SDK, Jaeger, Prometheus, Grafana | Aligns with existing experience |
| Testing | Vitest, Testcontainers, fast-check (property tests), k6 (load) | Real database in tests; reproducible benchmarks |
| Deployment | Docker Compose for local; one VM (or a PaaS) with managed Postgres and Redis for hosted | Student budget |

## 3.3 Data model

All tenant-owned tables carry `project_id`, and every query filters on it.

```sql
projects(id, name, owner_user_id, plan, created_at)
api_keys(id, project_id, key_prefix, key_hash, created_at, revoked_at)

endpoints(
  id, project_id, url, description,
  event_filter text[],           -- event types, empty = all
  secret_enc bytea,              -- encrypted signing secret(s), supports rotation
  status enum('active','disabled','paused'),
  ordering enum('none','fifo_by_key'),
  consecutive_failures int, disabled_at, created_at
)

events(
  id, project_id, type, payload jsonb,
  idempotency_key, created_at,
  UNIQUE (project_id, idempotency_key)
)

deliveries(                       -- outbox: one row per (event, endpoint)
  id, event_id, endpoint_id, project_id,
  status enum('pending','in_flight','succeeded','failed','dead'),
  attempt_count int, next_attempt_at timestamptz,
  locked_by, locked_until,
  last_status_code, last_error, created_at, completed_at
)
INDEX deliveries (status, next_attempt_at)

delivery_attempts(
  id, delivery_id, attempt_no, started_at, duration_ms,
  request_headers jsonb, response_status int,
  response_body_snippet text, error text
)

scenarios(id, project_id nullable, slug, name, difficulty, definition_yaml, is_public)
scenario_runs(id, project_id, scenario_id, endpoint_id, status, started_at, finished_at, report jsonb)
simulated_entities(id, run_id, kind, external_id, state, version, updated_at)
```

Retention: a daily job deletes attempts and payloads older than the plan's retention window.

## 3.4 API surface

Base path `/v1`. Auth with `Authorization: Bearer <api_key>`.

| Method and path | Purpose |
| --- | --- |
| `POST /events` | Accept an event. Requires `Idempotency-Key`. Returns 202 with event id. |
| `GET /events/:id` | Event with its deliveries |
| `POST /endpoints`, `GET /endpoints`, `PATCH /endpoints/:id`, `DELETE /endpoints/:id` | Endpoint management |
| `POST /endpoints/:id/rotate-secret` | Rotate signing secret (old secret valid for a grace window) |
| `GET /deliveries?status=&endpoint_id=` | Delivery log |
| `POST /deliveries/:id/replay` | Replay one delivery |
| `POST /replay` | Bulk replay with filters (time range, status, endpoint) |
| `GET /dlq`, `POST /dlq/retry` | Dead-letter queue |
| `GET /scenarios`, `POST /scenarios` | Scenario library and custom scenarios |
| `POST /runs` | Start a scenario run against an endpoint |
| `GET /runs/:id` | Run status, timeline and report |

Standard error body: `{ "error": { "code", "message", "request_id" } }`. Rate limit responses return 429 with `Retry-After`.

## 3.5 Delivery engine

### Request format

Each delivery is an HTTP POST with JSON body and these headers (modelled on the Standard Webhooks convention):

```
webhook-id:        msg_<delivery event id>        (stable across retries)
webhook-timestamp: <unix seconds>
webhook-signature: v1,<base64 HMAC-SHA256>
```

Signed content is `{webhook-id}.{webhook-timestamp}.{raw body}`. Receivers reject timestamps older than 5 minutes and compare signatures in constant time. During secret rotation, signatures for both secrets are sent, space-separated.

### Worker loop

1. Claim a batch of due deliveries:

   ```sql
   UPDATE deliveries SET status='in_flight', locked_by=$w, locked_until=now()+interval '60s'
   WHERE id IN (
     SELECT id FROM deliveries
     WHERE status='pending' AND next_attempt_at <= now()
     ORDER BY next_attempt_at
     LIMIT $n FOR UPDATE SKIP LOCKED)
   RETURNING *;
   ```
2. For each delivery, run SSRF checks (resolve DNS, reject private ranges, pin the resolved IP for the connection to defeat DNS rebinding), sign and send with a 10-second timeout and no redirect following.
3. Record the attempt. On 2xx mark `succeeded`. On other results compute the next attempt.
4. A reaper job returns deliveries whose `locked_until` has passed to `pending`. This is what makes a worker crash safe.

### Retry policy

- Retry on timeouts, network errors, 5xx, 408, 425, 429. Respect `Retry-After` when present.
- Do not retry on most 4xx (400, 401, 403, 404, 410) beyond a small fixed count, since they are usually configuration errors. 410 disables the endpoint.
- Schedule: 5s, 30s, 2m, 10m, 30m, 1h, 3h, 6h (8 attempts), each with plus or minus 20 percent jitter. Configurable per project.
- After the final failure the delivery becomes `dead` and appears in the DLQ.

### Endpoint health

An endpoint with 20 consecutive failures over at least 24 hours is paused. A low-rate probe checks recovery. On recovery it resumes and queued deliveries are released. The owner is notified by email.

### Ordering

By default there is no ordering guarantee, and the docs say so clearly. For `fifo_by_key`, a delivery is claimable only if no earlier delivery with the same ordering key is unfinished. This reduces throughput for that endpoint and is opt-in.

### Fair scheduling and rate limiting

- **Ingestion limit:** token bucket per project in Redis, enforced at the API.
- **Dispatch fairness:** the claim query is weighted so each project receives a bounded share of every batch (round-robin over projects with due work, capped per project per cycle). A project that floods the queue only fills its own share.
- **Per-endpoint concurrency cap:** a Redis counter limits in-flight requests to one endpoint (default 5) so HookLab does not overwhelm a student's laptop.
- The fairness property is validated in the load tests (see 3.8).

## 3.6 Simulator design

### Provider profiles

A provider profile is a set of payload templates and state machine definitions, versioned in the repo (`packages/simulator/providers/`). Payloads are described as "Razorpay-style", not claimed to be exact.

Example payment state machine:

```
created -> authorized -> captured -> refunded
               \-> failed
created -> failed
```

Each transition emits an event such as `payment.authorized`, `payment.captured`, `refund.processed`. The simulator rejects illegal transitions, which also allows scenarios to test handlers against realistic (and deliberately illegal) sequences.

### Scenario format

```yaml
name: Payment captured twice, refund arrives early
difficulty: intermediate
provider: razorpay-style
steps:
  - create_payment: { id: pay_1, amount: 49900, currency: INR }
  - emit: payment.authorized
  - emit: payment.captured
    faults: { duplicate: 1, delay_ms: 2000 }
  - emit: refund.processed
    faults: { reorder_before: payment.captured }
assertions:
  - all_deliveries_return_2xx_within: 5s
  - handler_idempotent: true
  - final_state:
      query: "GET {handler_state_url}/payments/pay_1"
      expect: { status: refunded, balance_changes: 1 }
```

**Fault types:** `delay_ms`, `duplicate`, `drop`, `reorder_before`, `respond_with` (force status codes from a proxy mode), `slow_response`, `burst`.

### Runner

A run compiles into delivery rows with future `next_attempt_at` values and fault flags, then the normal worker delivers them. The runner records a timeline and evaluates assertions after the last delivery. `handler_idempotent` is checked through an optional state callback that the student's app exposes (a small SDK helper makes this one line), and otherwise by checking that duplicate deliveries returned consistent responses.

### Built-in scenarios (initial list)

Happy path; duplicate delivery; out-of-order events; delayed event after timeout; slow endpoint; endpoint returns 500 twice then succeeds; UPI collect timeout; UPI collect success after delay; refund before capture; partial refund; webhook storm (50 events in 1 second); invalid signature handling; replayed old timestamp; KYC check pending then approved; KYC rejected then resubmitted.

## 3.7 Security

| Threat | Control |
| --- | --- |
| SSRF through endpoint URLs | HTTPS-only in hosted mode, DNS resolution plus IP pinning, blocklist for private, loopback, link-local and metadata ranges, no redirects |
| Abuse as an attack relay | Per-tenant and per-endpoint rate limits, endpoint ownership verification (a challenge event the endpoint must echo), global kill switch |
| Secret leakage | Signing secrets encrypted at rest with an application key, shown once, hashed API keys with a prefix for lookup |
| Cross-tenant data access | `project_id` in every query, enforced in a repository layer and tested with a dedicated isolation test suite |
| Replay of intercepted payloads | Timestamp in signed content and receiver-side tolerance window |
| Payload privacy | Payload snippets truncated, retention windows enforced, and a docs warning not to send real personal or card data |

## 3.8 Testing and benchmarking

**Correctness**

- Unit tests for signing, retry schedule and state machines.
- Property tests (fast-check) over scenarios: no illegal state transitions, and every accepted event ends in `succeeded` or `dead`.
- Integration tests with Testcontainers using a real Postgres and Redis.
- **Chaos tests:** kill workers mid-delivery, restart Postgres, drop Redis, and verify no accepted event is lost. Duplicates are allowed (at-least-once) and counted.

**Performance (k6)**

- Sustained ingestion and delivery at 500 events/s to a fast stub receiver for 30 minutes; record p50/p95/p99 time to first attempt.
- Slow-receiver test: 10 percent of endpoints respond in 8 seconds; verify others are unaffected.
- **Fairness test:** one tenant sends 50x its quota while others send normal traffic; report the change in other tenants' p95 latency (target at most 20 percent).
- Publish the results, hardware, and method in the docs and the final report.

## 3.9 Observability

- A trace spans API request, outbox insert, claim, delivery attempt and result. The trace id is stored on each attempt so the dashboard can link to Jaeger.
- Metrics: queue depth by status, oldest pending age, attempts by outcome, delivery latency histogram, retry count distribution, DLQ size, per-tenant throughput.
- Alerts (local Grafana): oldest pending age above 60 seconds, DLQ growth, worker heartbeat missing.

## 3.10 Repository layout

```
hooklab/
  apps/
    api/            Express API
    worker/         dispatcher and delivery workers
    dashboard/      Next.js app
    docs/           documentation site
  packages/
    core/           shared types, signing, retry policy
    simulator/      state machines, provider profiles, scenario runner
    sdk/            TypeScript SDK
    cli/            tunnel and run commands
  infra/            docker-compose, k6 scripts, grafana dashboards
  docs/adr/         architecture decision records
```

Keep architecture decision records for each major choice (outbox over broker, at-least-once, SSRF approach). They feed directly into the technical documentation checkpoint and the blog posts.

## 3.11 Open questions

1. Hosted tunnel: build a minimal one (WebSocket relay) or document use of an existing tunnel for v1? Recommendation: document an existing tunnel first, build the relay only if time allows.
2. Should free-tier endpoints be limited to a verified allowlist to reduce abuse risk? Recommendation: yes for launch, relax later.
3. How to expose the handler-state callback so it is easy for students on any framework? Recommendation: ship Express, FastAPI and Next.js snippets.

---

# Appendix: Form-ready summary (for the track selection form)

**Track:** Backend

**Project:** HookLab, a webhook delivery platform with a fintech event simulator for hackathon and student projects.

**New or enhancement:** New project.

**Problem statement:** Student and hackathon teams building payment, marketplace and bot projects cannot easily test how their webhook handlers behave under real failure conditions (duplicates, delays, out-of-order events), and cannot easily build reliable outbound webhook delivery. Their demos work in the happy path and break in production-like conditions.

**Proposed solution:** A multi-tenant platform that delivers signed webhooks with retries, a dead-letter queue, replay and delivery logs, plus a simulator that fires realistic fintech event sequences with injected faults at a developer's endpoint and reports pass or fail.

**Target users:** Hackathon participants, college project teams, indie developers, and educators or organisers who want to evaluate integrations.

**Scope:** Delivery engine, simulator with a scenario library, dashboard, SDK and CLI, per-tenant rate limits and fair scheduling, and a published load-test and chaos-test report. No real money movement, no multi-region.
