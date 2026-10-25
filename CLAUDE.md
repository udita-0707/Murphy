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
  worker/       dispatcher and delivery workers (phase 2, placeholder)
  dashboard/    Next.js dashboard (placeholder)
packages/
  core/         @murphy/core: signing, retry policy, canonical JSON hashing
  db/           @murphy/db: Prisma schema, migrations, client, repository layer
  simulator/    @murphy/simulator (placeholder)
  sdk/          @murphy/sdk (placeholder)
  cli/          @murphy/cli, bin "murphy" (placeholder)
infra/          docker-compose and other infrastructure
docs/
  BRIEF.md      problem brief, PRD and tech spec
  adr/          architecture decision records
```

## Commands

Run from the repo root.

| Command | What it does |
| --- | --- |
| `pnpm install` | Install dependencies |
| `docker compose -f infra/docker-compose.yml up -d` | Start Postgres 16 and Redis 7 |
| `pnpm dev` | Run all apps in watch mode (API on `PORT`, default 3000) |
| `pnpm build` | Build all packages |
| `pnpm test` | Run all tests (integration tests need Docker for Testcontainers) |
| `pnpm lint` | ESLint across the workspace |
| `pnpm typecheck` | `tsc --noEmit` across the workspace |
| `pnpm format` | Prettier write |
| `pnpm db:migrate` | Apply Prisma migrations (`prisma migrate deploy`) to `DATABASE_URL` |
| `pnpm db:seed` | Create a project and print its API key once |

Copy `.env.example` to `.env` and fill it in before running the API or migrations.

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

- Phase 1: API, core, db only. Worker, retries execution, DLQ, SSRF and outbound HTTP are
  phase 2.
- Cut from v1: KYC provider, FIFO ordering (`endpoints.ordering`), endpoint auto-disable,
  hosted tunnel, Python SDK, docs site, Grafana.
