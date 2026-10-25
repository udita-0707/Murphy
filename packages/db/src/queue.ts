import { Prisma, type PrismaClient } from "@prisma/client";
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

/** Everything the worker needs to send one attempt. */
export interface DeliveryContext {
  deliveryId: string;
  projectId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  endpointId: string;
  endpointUrl: string;
  secretEnc: Buffer;
  attemptCount: number;
  clientErrorCount: number;
}

/** One logged attempt. request_headers include the signature but never the secret. */
export interface AttemptLog {
  startedAt: Date;
  durationMs: number;
  requestHeaders: Record<string, string>;
  responseStatus: number | null;
  responseBodySnippet: string | null;
  error: string | null;
}

/** How the delivery row changes after an attempt. */
export type AttemptOutcome =
  | { kind: "succeeded"; attemptCount: number; clientErrorCount: number; lastStatusCode: number }
  | {
      kind: "retry";
      attemptCount: number;
      clientErrorCount: number;
      delayMs: number;
      lastStatusCode: number | null;
      lastError: string | null;
    }
  | {
      kind: "dead";
      attemptCount: number;
      clientErrorCount: number;
      lastStatusCode: number | null;
      lastError: string | null;
      /** 410 Gone: also disable the endpoint so its other deliveries park. */
      disableEndpoint: boolean;
    }
  /** No state change, e.g. the worker is shutting down and its lease is being released. */
  | { kind: "none" };

export interface ReapedDelivery {
  id: string;
  projectId: string;
  previousWorker: string | null;
  reapCount: number;
  /** pending: due now, not counted. retry: counted, backed off. dead: counted, exhausted. */
  outcome: "pending" | "retry" | "dead";
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

    /** Loads the event, endpoint and counters for a delivery leased to this worker. */
    async loadContext(deliveryId: string, workerId: string): Promise<DeliveryContext | null> {
      const rows = await prisma.$queryRaw<
        (Omit<DeliveryContext, "secretEnc"> & { secretEnc: Uint8Array })[]
      >`
        SELECT d.id::text AS "deliveryId", d.project_id::text AS "projectId",
               ev.id::text AS "eventId", ev.type AS "eventType", ev.payload AS "payload",
               e.id::text AS "endpointId", e.url AS "endpointUrl", e.secret_enc AS "secretEnc",
               d.attempt_count AS "attemptCount", d.client_error_count AS "clientErrorCount"
        FROM deliveries d
        JOIN events ev ON ev.id = d.event_id AND ev.project_id = d.project_id
        JOIN endpoints e ON e.id = d.endpoint_id AND e.project_id = d.project_id
        WHERE d.id = ${deliveryId}::uuid AND d.status = 'in_flight' AND d.locked_by = ${workerId}`;
      const row = rows[0];
      return row ? { ...row, secretEnc: Buffer.from(row.secretEnc) } : null;
    },

    /**
     * Logs an attempt and applies its outcome in one transaction.
     *
     * attempt_no is the next number for this delivery and keeps increasing across retries,
     * reaps and replays. The delivery update is guarded by status = 'in_flight' AND
     * locked_by = workerId: if the delivery was cancelled (endpoint deleted, ADR 003) or its
     * lease was reaped meanwhile, the attempt is still logged but the row is left alone.
     * Returns whether the guarded update applied.
     */
    async recordAttempt(
      deliveryId: string,
      workerId: string,
      attempt: AttemptLog,
      outcome: AttemptOutcome,
    ): Promise<{ applied: boolean; attemptNo: number }> {
      return prisma.$transaction(async (tx) => {
        // Serialises attempt numbering per delivery.
        const locked = await tx.$queryRaw<{ project_id: string }[]>`
          SELECT project_id::text FROM deliveries WHERE id = ${deliveryId}::uuid FOR UPDATE`;
        const projectId = locked[0]?.project_id;
        if (!projectId) return { applied: false, attemptNo: 0 };

        const inserted = await tx.$queryRaw<{ attempt_no: number }[]>`
          INSERT INTO delivery_attempts (delivery_id, project_id, attempt_no, started_at, duration_ms,
                                         request_headers, response_status, response_body_snippet, error)
          SELECT ${deliveryId}::uuid, ${projectId}::uuid, COALESCE(MAX(attempt_no), 0) + 1,
                 ${attempt.startedAt}, ${attempt.durationMs},
                 ${JSON.stringify(attempt.requestHeaders)}::jsonb, ${attempt.responseStatus},
                 ${attempt.responseBodySnippet}, ${attempt.error}
          FROM delivery_attempts WHERE delivery_id = ${deliveryId}::uuid
          RETURNING attempt_no`;
        const attemptNo = inserted[0]!.attempt_no;

        if (outcome.kind === "none") return { applied: false, attemptNo };

        const guard = Prisma.sql`id = ${deliveryId}::uuid AND status = 'in_flight' AND locked_by = ${workerId}`;
        let updated: number;
        switch (outcome.kind) {
          case "succeeded":
            updated = await tx.$executeRaw`
              UPDATE deliveries SET status = 'succeeded', attempt_count = ${outcome.attemptCount},
                client_error_count = ${outcome.clientErrorCount},
                last_status_code = ${outcome.lastStatusCode}, last_error = NULL,
                completed_at = now(), locked_by = NULL, locked_until = NULL
              WHERE ${guard}`;
            break;
          case "retry":
            updated = await tx.$executeRaw`
              UPDATE deliveries SET status = 'pending', attempt_count = ${outcome.attemptCount},
                client_error_count = ${outcome.clientErrorCount},
                next_attempt_at = now() + make_interval(secs => ${outcome.delayMs / 1000}),
                last_status_code = ${outcome.lastStatusCode}, last_error = ${outcome.lastError},
                locked_by = NULL, locked_until = NULL
              WHERE ${guard}`;
            break;
          case "dead":
            updated = await tx.$executeRaw`
              UPDATE deliveries SET status = 'dead', attempt_count = ${outcome.attemptCount},
                client_error_count = ${outcome.clientErrorCount},
                last_status_code = ${outcome.lastStatusCode}, last_error = ${outcome.lastError},
                completed_at = now(), locked_by = NULL, locked_until = NULL
              WHERE ${guard}`;
            if (updated > 0 && outcome.disableEndpoint) {
              await tx.$executeRaw`
                UPDATE endpoints e SET status = 'disabled', disabled_at = now()
                FROM deliveries d
                WHERE d.id = ${deliveryId}::uuid AND e.id = d.endpoint_id
                  AND e.project_id = d.project_id AND e.deleted_at IS NULL`;
            }
            break;
        }
        return { applied: updated > 0, attemptNo };
      });
    },

    /**
     * Returns deliveries whose lease has expired (their worker died or hung) to pending, due
     * immediately. Expired rows are locked with SKIP LOCKED, so several reapers can run at
     * once without reaping a row twice.
     *
     * Each reap is logged as an attempt row with error 'lease_expired'. Reaps do not count
     * toward attempt_count, except under the poison guard (ADR 007): from the
     * (freeReaps + 1)-th reap of the same delivery on, a reap counts as an attempt and
     * follows the backoff schedule given by `retryDelay`, going dead when it returns null.
     */
    async reapExpired(options: {
      limit: number;
      freeReaps: number;
      /** Backoff after the attempt numbered `attemptCount` failed; null means exhausted. */
      retryDelay: (attemptCount: number) => number | null;
    }): Promise<ReapedDelivery[]> {
      return prisma.$transaction(async (tx) => {
        const expired = await tx.$queryRaw<
          {
            id: string;
            project_id: string;
            attempt_count: number;
            reap_count: number;
            locked_by: string | null;
          }[]
        >`
          SELECT id::text, project_id::text, attempt_count, reap_count, locked_by
          FROM deliveries
          WHERE status = 'in_flight' AND locked_until < now()
          ORDER BY locked_until
          LIMIT ${options.limit}
          FOR UPDATE SKIP LOCKED`;

        const reaped: ReapedDelivery[] = [];
        for (const row of expired) {
          const reapCount = row.reap_count + 1;
          const counted = reapCount > options.freeReaps;
          const attemptCount = counted ? row.attempt_count + 1 : row.attempt_count;
          const delayMs = counted ? options.retryDelay(attemptCount) : 0;
          const outcome: ReapedDelivery["outcome"] =
            delayMs === null ? "dead" : counted ? "retry" : "pending";
          const error = counted
            ? `lease_expired: reaped ${reapCount} times, counted as attempt ${attemptCount}`
            : "lease_expired";

          await tx.$executeRaw`
            INSERT INTO delivery_attempts (delivery_id, project_id, attempt_no, started_at,
                                           request_headers, error)
            SELECT ${row.id}::uuid, ${row.project_id}::uuid, COALESCE(MAX(attempt_no), 0) + 1,
                   now(), ${JSON.stringify({ "x-murphy-worker": row.locked_by ?? "" })}::jsonb, ${error}
            FROM delivery_attempts WHERE delivery_id = ${row.id}::uuid`;

          if (outcome === "dead") {
            await tx.$executeRaw`
              UPDATE deliveries SET status = 'dead', reap_count = ${reapCount},
                attempt_count = ${attemptCount}, last_status_code = NULL, last_error = ${error},
                completed_at = now(), locked_by = NULL, locked_until = NULL
              WHERE id = ${row.id}::uuid`;
          } else {
            await tx.$executeRaw`
              UPDATE deliveries SET status = 'pending', reap_count = ${reapCount},
                attempt_count = ${attemptCount}, last_error = ${error},
                next_attempt_at = now() + make_interval(secs => ${(delayMs ?? 0) / 1000}),
                locked_by = NULL, locked_until = NULL
              WHERE id = ${row.id}::uuid`;
          }
          reaped.push({
            id: row.id,
            projectId: row.project_id,
            previousWorker: row.locked_by,
            reapCount,
            outcome,
          });
        }
        return reaped;
      });
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
