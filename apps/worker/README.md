# @murphy/worker

Claims due deliveries from the Postgres outbox (ADR 001, ADR 004), signs and sends them, logs
every attempt and schedules retries. Run with `pnpm --filter @murphy/worker start`, or
`pnpm dev` at the repo root to run it alongside the API.

Configuration comes from the repo-root `.env`; see `.env.example`.
