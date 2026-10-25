-- CreateEnum
CREATE TYPE "project_plan" AS ENUM ('free', 'edu');

-- CreateEnum
CREATE TYPE "endpoint_status" AS ENUM ('active', 'disabled', 'paused');

-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('pending', 'in_flight', 'succeeded', 'failed', 'dead');

-- CreateEnum
CREATE TYPE "scenario_difficulty" AS ENUM ('beginner', 'intermediate', 'advanced');

-- CreateEnum
CREATE TYPE "scenario_run_status" AS ENUM ('pending', 'running', 'passed', 'failed', 'errored');

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "owner_user_id" TEXT,
    "plan" "project_plan" NOT NULL DEFAULT 'free',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "endpoints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "event_filter" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "secret_enc" BYTEA NOT NULL,
    "status" "endpoint_status" NOT NULL DEFAULT 'active',
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "disabled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "status" "delivery_status" NOT NULL DEFAULT 'pending',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_by" TEXT,
    "locked_until" TIMESTAMPTZ(6),
    "last_status_code" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "delivery_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "duration_ms" INTEGER,
    "request_headers" JSONB NOT NULL,
    "response_status" INTEGER,
    "response_body_snippet" TEXT,
    "error" TEXT,

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenarios" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "difficulty" "scenario_difficulty" NOT NULL,
    "definition_yaml" TEXT NOT NULL,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenario_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "scenario_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "status" "scenario_run_status" NOT NULL DEFAULT 'pending',
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "report" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scenario_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "simulated_entities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "simulated_entities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "projects_owner_user_id_idx" ON "projects"("owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_prefix_key" ON "api_keys"("key_prefix");

-- CreateIndex
CREATE INDEX "api_keys_project_id_idx" ON "api_keys"("project_id");

-- CreateIndex
CREATE INDEX "endpoints_project_id_idx" ON "endpoints"("project_id");

-- CreateIndex
CREATE INDEX "events_project_id_created_at_idx" ON "events"("project_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "events_project_id_idempotency_key_key" ON "events"("project_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "deliveries_status_next_attempt_at_idx" ON "deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "deliveries_project_id_idx" ON "deliveries"("project_id");

-- CreateIndex
CREATE INDEX "deliveries_event_id_idx" ON "deliveries"("event_id");

-- CreateIndex
CREATE INDEX "deliveries_endpoint_id_idx" ON "deliveries"("endpoint_id");

-- CreateIndex
CREATE INDEX "delivery_attempts_project_id_idx" ON "delivery_attempts"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_attempts_delivery_id_attempt_no_key" ON "delivery_attempts"("delivery_id", "attempt_no");

-- CreateIndex
CREATE INDEX "scenarios_project_id_idx" ON "scenarios"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "scenarios_project_id_slug_key" ON "scenarios"("project_id", "slug");

-- CreateIndex
CREATE INDEX "scenario_runs_project_id_idx" ON "scenario_runs"("project_id");

-- CreateIndex
CREATE INDEX "scenario_runs_scenario_id_idx" ON "scenario_runs"("scenario_id");

-- CreateIndex
CREATE INDEX "scenario_runs_endpoint_id_idx" ON "scenario_runs"("endpoint_id");

-- CreateIndex
CREATE INDEX "simulated_entities_project_id_idx" ON "simulated_entities"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "simulated_entities_run_id_kind_external_id_key" ON "simulated_entities"("run_id", "kind", "external_id");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_runs" ADD CONSTRAINT "scenario_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_runs" ADD CONSTRAINT "scenario_runs_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenario_runs" ADD CONSTRAINT "scenario_runs_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulated_entities" ADD CONSTRAINT "simulated_entities_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "simulated_entities" ADD CONSTRAINT "simulated_entities_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "scenario_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

