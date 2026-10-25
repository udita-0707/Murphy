# Murphy

> Murphy breaks your webhooks so production can't.

Murphy is a multi-tenant webhook delivery platform (signing, retries, dead-letter queue,
replay, delivery logs) with a fintech event simulator that fires realistic Razorpay-style,
UPI-style and KYC-style event sequences with injected faults (duplicates, delays,
reordering, drops) at a developer's endpoint and reports pass or fail.

`docs/BRIEF.md` is the source of truth for product and technical decisions. It uses the old
working name "HookLab"; always use **Murphy** in code, docs and UI.

Deadline: deployed demo for the hackathon on 12 Nov 2026. Udita is the sole developer and
makes all final decisions.

## Stack

- TypeScript (strict), Node >= 20
- pnpm workspaces + Turborepo
- API: Express + Zod
- Database: PostgreSQL 16 + Prisma (raw SQL only where needed, e.g. `ON CONFLICT`, `SKIP LOCKED`)
- Redis 7 (rate limits and fairness only, never the source of truth)
- Tests: Vitest, Testcontainers (real Postgres), fast-check (property tests)
- Local infra: Docker Compose (`infra/docker-compose.yml`)

## Repo layout

```
apps/
  api/          Express API (@murphy/api)
  worker/       delivery worker: fair claim, SSRF guard, retries, reaper (@murphy/worker)
  dashboard/    Next.js dashboard (placeholder)
packages/
  core/         @murphy/core: signing, retry policy, canonical JSON hashing
  db/           @murphy/db: Prisma schema, migrations, client, repository layer, delivery queue
  simulator/    @murphy/simulator (placeholder)
  sdk/          @murphy/sdk (placeholder)
  cli/          @murphy/cli, bin "murphy" (placeholder)
tools/
  dev-receiver/ @murphy/dev-receiver: local receiver that verifies signatures, simulates failures
  demo-reset/   @murphy/demo-reset: `pnpm demo:reset` (refuses outside local mode / localhost DB)
infra/          docker-compose and other infrastructure
docs/
  BRIEF.md      problem brief, PRD and tech spec
  adr/          architecture decision records
  handover/     phase handover notes
```

## Commands

Run from the repo root.

| Command           | What it does                                                        |
| ----------------- | ------------------------------------------------------------------- |
| `pnpm install`    | Install dependencies                                                |
| `pnpm infra:up`   | Start Postgres 16 and Redis 7 (reads credentials from `.env`)       |
| `pnpm infra:down` | Stop them (data stays in the `murphy-pgdata` volume)                |
| `pnpm dev`        | Run the API (on `PORT`, default 3000) and the worker in watch mode  |
| `pnpm receiver`   | Dev receiver on :4242 (`RECEIVER_SECRET=whsec_...`, `--fail N`)     |
| `pnpm build`      | Build all packages                                                  |
| `pnpm test`       | Run all tests (integration tests need Docker for Testcontainers)    |
| `pnpm lint`       | ESLint across the workspace                                         |
| `pnpm typecheck`  | `tsc --noEmit` across the workspace                                 |
| `pnpm format`     | Prettier write                                                      |
| `pnpm db:migrate` | Apply Prisma migrations (`prisma migrate deploy`) to `DATABASE_URL` |
| `pnpm db:seed`    | Create a project and print its API key once                         |
| `pnpm demo:reset` | Wipe and re-seed the local DB before every demo (local mode only)   |

Copy `.env.example` to `.env` and fill it in (set a real `POSTGRES_PASSWORD` and use it in
`DATABASE_URL`) before starting infra, the API or migrations.

## Rules

- **Strict TypeScript.** No `any` unless justified in a comment; keep `strict` and
  `noUncheckedIndexedAccess` on.
- **Tenant isolation.** Every tenant-owned query filters on `project_id`, and goes through
  the repository layer in `packages/db`. Every tenant repository function takes `projectId`
  as its first argument. Route handlers never import or use Prisma directly.
- **No secrets in code.** Secrets come from the environment (`.env`, never committed).
  Signing secrets are encrypted at rest; API keys are stored hashed.
- **Small commits** with conventional messages (`feat:`, `fix:`, `chore:`, `docs:`, `test:`,
  `refactor:`).
- **A test with every feature.** Unit tests for pure logic, Testcontainers integration tests
  for anything touching the database.
- **An ADR in `docs/adr`** for each major decision (numbered `NNN-short-title.md`).
- **Never push** without Udita's say-so.

## Scope notes

- Phase 1 (done): API, core, db. Phase 2 (done): worker, retries, reaper, DLQ, replay, SSRF
  guard, dev receiver. Phase 3 is the simulator.
- `MURPHY_MODE` must default to `hosted`. Local development sets `MURPHY_MODE=local` in `.env`.
- Delivery is at-least-once; receivers deduplicate on `webhook-id` (ADR 001, 006, 007).
- The partial index `deliveries_pending_project_due_idx` exists only in migrations; delete
  any `DROP INDEX` for it that `prisma migrate dev` generates (ADR 004).
- Cut from v1: KYC provider, FIFO ordering (`endpoints.ordering`), endpoint auto-disable,
  hosted tunnel, Python SDK, docs site, Grafana, signing-secret rotation endpoint.
