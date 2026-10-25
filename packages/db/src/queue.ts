import type { PrismaClient } from "@prisma/client";
import type { DeliveryStatus } from "./types.js";

/**
 * Cross-tenant queue operations used only by the worker. Unlike the repository layer these
 * do not take a projectId: claiming due work across all projects is the point. Each claimed
 * row carries its project_id, and every later write is keyed on the delivery id plus the
 * worker's lease.
 */

export interface ClaimOptions {
  workerId: string;
  /** Maximum rows claimed in this call. */
  batchSize: number;
  /** Maximum rows any single project may contribute to this call (fairness, ADR 004). */
  projectCap: number;
  leaseMs: number;
}

export interface ClaimedDelivery {
  id: string;
  projectId: string;
  eventId: string;
  endpointId: string;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  lockedBy: string;
  lockedUntil: Date;
}

export function createDeliveryQueue(prisma: PrismaClient) {
  return {
    /**
     * Claims up to `batchSize` due deliveries, at most `projectCap` per project, and leases
     * them to `workerId` (status in_flight, locked_until = now + lease).
     *
     * For each project with due work, a LATERAL subquery takes that project's oldest due rows
     * with FOR UPDATE SKIP LOCKED, so concurrent workers never claim the same row. Rows are
     * then ranked within their project and taken round-robin (every project's 1st row, then
     * every project's 2nd row, ...), so a project with a huge backlog cannot crowd out a
     * project with one delivery. Deliveries of disabled, paused or deleted endpoints are
     * skipped (parked).
     */
    async claim(options: ClaimOptions): Promise<ClaimedDelivery[]> {
      const { workerId, batchSize, projectCap, leaseMs } = options;
      if (batchSize <= 0 || projectCap <= 0) return [];
      return prisma.$queryRaw<ClaimedDelivery[]>`
        WITH due_projects AS (
          SELECT DISTINCT d.project_id
          FROM deliveries d
          WHERE d.status = 'pending' AND d.next_attempt_at <= now()
        ),
        candidates AS (
          SELECT c.id, c.next_attempt_at,
                 row_number() OVER (PARTITION BY p.project_id ORDER BY c.next_attempt_at, c.id) AS rank
          FROM due_projects p
          CROSS JOIN LATERAL (
            SELECT d.id, d.next_attempt_at
            FROM deliveries d
            JOIN endpoints e ON e.id = d.endpoint_id
            WHERE d.project_id = p.project_id
              AND d.status = 'pending'
              AND d.next_attempt_at <= now()
              AND e.status = 'active'
              AND e.deleted_at IS NULL
            ORDER BY d.next_attempt_at, d.id
            LIMIT ${projectCap}
            FOR UPDATE OF d SKIP LOCKED
          ) c
        ),
        picked AS (
          SELECT id FROM candidates
          ORDER BY rank, next_attempt_at, id
          LIMIT ${batchSize}
        )
        UPDATE deliveries d
        SET status = 'in_flight',
            locked_by = ${workerId},
            locked_until = now() + make_interval(secs => ${leaseMs / 1000})
        FROM picked
        WHERE d.id = picked.id
        RETURNING d.id::text AS "id", d.project_id::text AS "projectId",
                  d.event_id::text AS "eventId", d.endpoint_id::text AS "endpointId",
                  d.status::text AS "status", d.attempt_count AS "attemptCount",
                  d.next_attempt_at AS "nextAttemptAt", d.locked_by AS "lockedBy",
                  d.locked_until AS "lockedUntil"`;
    },

    /**
     * Returns every delivery still leased to this worker to pending, without counting an
     * attempt. Used on graceful shutdown. next_attempt_at is unchanged, so they are due again
     * immediately.
     */
    async releaseLeases(workerId: string, ids?: readonly string[]): Promise<number> {
      return prisma.delivery
        .updateMany({
          where: {
            lockedBy: workerId,
            status: "in_flight",
            ...(ids ? { id: { in: [...ids] } } : {}),
          },
          data: { status: "pending", lockedBy: null, lockedUntil: null },
        })
        .then((r) => r.count);
    },
  };
}

export type DeliveryQueue = ReturnType<typeof createDeliveryQueue>;
