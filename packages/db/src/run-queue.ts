import type { PrismaClient } from "@prisma/client";
import type { FinishableRun, JsonObject, ScenarioRunStatus } from "./types.js";

/**
 * What the worker's run finisher needs. Like the delivery queue, finding work crosses tenants;
 * everything that reads or writes one run's data is scoped to its project.
 */
export function createRunQueue(prisma: PrismaClient) {
  return {
    /** Running runs with nothing left to send, or past their deadline. */
    async listFinishable(limit = 20): Promise<FinishableRun[]> {
      return prisma.$queryRaw<FinishableRun[]>`
        SELECT r.id::text AS "id", r.project_id::text AS "projectId",
               COALESCE(r.deadline_at <= now(), false) AS "deadlinePassed"
        FROM scenario_runs r
        WHERE r.status = 'running'
          AND (r.deadline_at <= now() OR NOT EXISTS (
            SELECT 1 FROM events ev
            JOIN deliveries d ON d.event_id = ev.id AND d.project_id = ev.project_id
            WHERE ev.scenario_run_id = r.id AND ev.project_id = r.project_id
              AND d.status IN ('pending', 'in_flight')))
        ORDER BY r.started_at
        LIMIT ${limit}`;
    },

    /** Stores the verdict once. Returns false if another worker already finished this run. */
    async finish(
      projectId: string,
      runId: string,
      status: Extract<ScenarioRunStatus, "passed" | "failed" | "errored">,
      report: JsonObject,
    ): Promise<boolean> {
      const { count } = await prisma.scenarioRun.updateMany({
        where: { id: runId, projectId, status: "running" },
        data: { status, report, finishedAt: new Date() },
      });
      return count > 0;
    },
  };
}

export type RunQueue = ReturnType<typeof createRunQueue>;
