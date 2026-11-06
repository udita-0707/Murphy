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
- Dashboard: Next.js 15 (App Router), Tailwind 4, Hallmark's Wayfind theme (`docs/design/direction.md`)
- No Redis (ADR 016)
- Tests: Vitest, Testcontainers (real Postgres), fast-check (property tests)
- Local infra: Docker Compose (`infra/docker-compose.yml`)

## Repo layout

```
apps/
  api/          Express API (@murphy/api)
  worker/       delivery worker: fair claim, SSRF guard, retries, reaper (@murphy/worker)
  dashboard/    @murphy/dashboard: Next.js dashboard on :3100, a same-origin proxy to the API (ADR 013)
packages/
  core/         @murphy/core: signing, retry policy, canonical JSON hashing, local-only guard
  client/       @murphy/client: API client and demo target setup, shared by the CLI and dashboard
  db/           @murphy/db: Prisma schema, migrations, client, repository layer, delivery queue
  simulator/    @murphy/simulator: provider profiles, YAML scenarios, compiler, reports, library
  sdk/          @murphy/sdk: murphyTarget() middleware for handlers under test
  cli/          @murphy/cli: `pnpm -s murphy run`
tools/
  dev-receiver/ @murphy/dev-receiver: local receiver that verifies signatures, simulates failures
  demo-reset/   @murphy/demo-reset: `pnpm demo:reset` (refuses outside local mode / localhost DB)
  chaos/        @murphy/chaos: `pnpm chaos` and `pnpm load`, real processes, faults, report
  demo-target/  @murphy/demo-target: `pnpm demo:target`, a naive and an idempotent handler
  control/      @murphy/control: local-only control service for the chaos panel, and `pnpm demo:stack`
infra/          docker-compose and other infrastructure
docs/
  BRIEF.md      problem brief, PRD and tech spec
  adr/          architecture decision records
  handover/     phase handover notes
  design/       the approved design direction
  chaos-report.md  generated evidence for "no accepted event is lost" (phase 3)
  run-report-schema.md  run report v1, the `_murphy` block and the target state contract
```

## Commands

Run from the repo root.

| Command            | What it does                                                           |
| ------------------ | ---------------------------------------------------------------------- |
| `pnpm install`     | Install dependencies                                                   |
| `pnpm infra:up`    | Start Postgres 16 (reads credentials from `.env`)                      |
| `pnpm infra:down`  | Stop them (data stays in the `murphy-pgdata` volume)                   |
| `pnpm dev`         | API (`PORT`, default 3000), worker and dashboard (:3100) in watch mode |
| `pnpm demo:stack`  | The demo: dashboard, API, target, two workers, chaos panel (local)     |
| `pnpm receiver`    | Dev receiver on :4242 (`RECEIVER_SECRET=whsec_...`, `--fail N`)        |
| `pnpm build`       | Build all packages                                                     |
| `pnpm test`        | Run all tests (integration tests need Docker for Testcontainers)       |
| `pnpm lint`        | ESLint across the workspace                                            |
| `pnpm typecheck`   | `tsc --noEmit` across the workspace                                    |
| `pnpm format`      | Prettier write                                                         |
| `pnpm db:migrate`  | Apply Prisma migrations (`prisma migrate deploy`) to `DATABASE_URL`    |
| `pnpm db:seed`     | Create a project and print its API key once                            |
| `pnpm demo:reset`  | Wipe and re-seed the local DB before every demo (local mode only)      |
| `pnpm chaos`       | Chaos run, needs Docker (`--seed N`, `--sabotage`, `--out`)            |
| `pnpm load`        | Local ingestion baseline, needs Docker (`--seconds`, `--connections`)  |
| `pnpm demo:target` | Demo target on :4343 (`/naive`, `/idempotent`), localhost only         |
| `pnpm -s murphy`   | `murphy run <file> --target naive\|idempotent`, needs `MURPHY_API_KEY` |

`pnpm test` caches through Turborepo. To really re-run tests, use `pnpm exec turbo run test --force`.

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
  guard, dev receiver. Phase 3 (done): reliability proof with property tests, chaos harness and
  report. Phase 4 (done): simulator, `murphyTarget()`, `murphy run`. Phase 5: dashboard, items a to h
  done; hosted deployment (item i) needs Udita's go-ahead first. See `docs/handover/phase-5.md`.
- The chaos panel and `tools/control` are local only, and never part of a hosted deployment (ADR 015).
- Humour stays in empty, loading and login states. Reports, evidence and verdicts stay deadpan.
- After changing `apps/dashboard/src/styles`, run `pnpm --filter @murphy/dashboard export-assets`. A test fails on drift.
- `pnpm test` runs at most 5 packages at once (`turbo.json`): more overloads Docker on this machine.
- The simulator has no delivery path of its own: a run only writes `events` and `deliveries` rows, and
  the delivery code has no simulator logic (ADR 011). Keep it that way.
- A run is `errored`, proving nothing, if a planned fault did not happen. Never report that as a pass.
- The run report is versioned (`docs/run-report-schema.md`, ADR 012). Changing a field's meaning needs a new
  version.
- `WORKER_RETRY_SCHEDULE_MS` is for local chaos runs only; the worker refuses it outside
  `MURPHY_MODE=local` (ADR 010).
- A disable stops new claims only. A delivery already `in_flight` is still sent (ADR 009).
- `MURPHY_MODE` must default to `hosted`. Local development sets `MURPHY_MODE=local` in `.env`.
- Delivery is at-least-once; receivers deduplicate on `webhook-id` (ADR 001, 006, 007).
- The partial indexes `deliveries_pending_project_due_idx`, `scenarios_builtin_slug_key` and
  `projects_owner_user_id_key` exist only in migrations; delete any `DROP INDEX` for them that `prisma migrate dev` generates (ADR 004).
- Do not run `pnpm install` or `prisma generate` while tests run: replacing Prisma's engine breaks them.
- Retention job (brief 3.3): not built; phase 6 only if time allows.
- Cut from v1: KYC provider, FIFO ordering (`endpoints.ordering`), endpoint auto-disable,
  hosted tunnel, Python SDK, docs site, Grafana, signing-secret rotation endpoint.
