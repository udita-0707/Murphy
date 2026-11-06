-- Simulator runs (ADR 011). Additive only: every new column is nullable, so existing rows stay valid.

-- Marks an event as simulated, and links it to its run.
ALTER TABLE "events" ADD COLUMN "scenario_run_id" UUID;
ALTER TABLE "events" ADD CONSTRAINT "events_scenario_run_id_fkey"
  FOREIGN KEY ("scenario_run_id") REFERENCES "scenario_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "events_scenario_run_id_idx" ON "events"("scenario_run_id");

ALTER TABLE "scenario_runs" ADD COLUMN "seed" INTEGER;
ALTER TABLE "scenario_runs" ADD COLUMN "target_label" TEXT;
ALTER TABLE "scenario_runs" ADD COLUMN "state_url" TEXT;
ALTER TABLE "scenario_runs" ADD COLUMN "deadline_at" TIMESTAMPTZ(6);
ALTER TABLE "scenario_runs" ADD COLUMN "plan" JSONB;
CREATE INDEX "scenario_runs_status_idx" ON "scenario_runs"("status");

-- Built-in scenarios have a null project_id, which the (project_id, slug) unique index does not
-- cover. Exists only here, like deliveries_pending_project_due_idx: delete any DROP INDEX for it
-- that `prisma migrate dev` generates.
CREATE UNIQUE INDEX "scenarios_builtin_slug_key" ON "scenarios"("slug") WHERE "project_id" IS NULL;
