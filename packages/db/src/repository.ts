import { Prisma, type PrismaClient } from "@prisma/client";
import {
  BULK_REPLAY_CAP,
  type AcceptEventInput,
  type AcceptEventResult,
  type ApiKeyRecord,
  type BulkReplayFilter,
  type CreateEndpointInput,
  type DeliveryListFilter,
  type DeliveryPage,
  type DeliveryRecord,
  type DeliveryWithAttempts,
  type EndpointRecord,
  type EventWithDeliveries,
  type JsonValue,
  type ProjectPlan,
  type ProjectRecord,
  type ReplayResult,
  type UpdateEndpointInput,
} from "./types.js";

const endpointSelect = {
  id: true,
  projectId: true,
  url: true,
  description: true,
  eventFilter: true,
  status: true,
  consecutiveFailures: true,
  disabledAt: true,
  createdAt: true,
} satisfies Prisma.EndpointSelect;

const deliverySelect = {
  id: true,
  eventId: true,
  endpointId: true,
  projectId: true,
  status: true,
  attemptCount: true,
  clientErrorCount: true,
  nextAttemptAt: true,
  lastStatusCode: true,
  lastError: true,
  createdAt: true,
  completedAt: true,
} satisfies Prisma.DeliverySelect;

/**
 * The only way application code touches the database.
 *
 * Every function on a tenant-owned table takes `projectId` first and filters on it. The
 * exceptions are creating a project and looking up an API key by prefix, which happen before
 * a tenant is known.
 */
export function createRepository(prisma: PrismaClient) {
  return {
    projects: {
      async create(input: { name: string; ownerUserId?: string | null; plan?: ProjectPlan }) {
        return (await prisma.project.create({
          data: { name: input.name, ownerUserId: input.ownerUserId ?? null, plan: input.plan },
        })) satisfies ProjectRecord;
      },
    },

    apiKeys: {
      async create(projectId: string, input: { keyPrefix: string; keyHash: Buffer }) {
        const row = await prisma.apiKey.create({
          data: { projectId, keyPrefix: input.keyPrefix, keyHash: toBytes(input.keyHash) },
        });
        return toApiKey(row);
      },

      /** Pre-authentication lookup: returns the key only if it exists and is not revoked. */
      async findActiveByPrefix(keyPrefix: string): Promise<ApiKeyRecord | null> {
        const row = await prisma.apiKey.findFirst({ where: { keyPrefix, revokedAt: null } });
        return row ? toApiKey(row) : null;
      },
    },

    endpoints: {
      async create(projectId: string, input: CreateEndpointInput): Promise<EndpointRecord> {
        return prisma.endpoint.create({
          data: {
            projectId,
            url: input.url,
            description: input.description ?? null,
            eventFilter: input.eventFilter ?? [],
            secretEnc: toBytes(input.secretEnc),
            status: input.status,
          },
          select: endpointSelect,
        });
      },

      async list(projectId: string): Promise<EndpointRecord[]> {
        return prisma.endpoint.findMany({
          where: { projectId, deletedAt: null },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: endpointSelect,
        });
      },

      async get(projectId: string, id: string): Promise<EndpointRecord | null> {
        return prisma.endpoint.findFirst({
          where: { id, projectId, deletedAt: null },
          select: endpointSelect,
        });
      },

      async update(
        projectId: string,
        id: string,
        input: UpdateEndpointInput,
      ): Promise<EndpointRecord | null> {
        const { count } = await prisma.endpoint.updateMany({
          where: { id, projectId, deletedAt: null },
          data: input,
        });
        if (count === 0) return null;
        return prisma.endpoint.findFirst({
          where: { id, projectId, deletedAt: null },
          select: endpointSelect,
        });
      },

      /**
       * Soft-deletes an endpoint (ADR 003) and cancels its unfinished deliveries, in one
       * transaction. Delivery and attempt history stay queryable. Returns false if the
       * endpoint does not exist in this project or is already deleted.
       */
      async delete(projectId: string, id: string): Promise<boolean> {
        return prisma.$transaction(async (tx) => {
          const now = new Date();
          const { count } = await tx.endpoint.updateMany({
            where: { id, projectId, deletedAt: null },
            data: { deletedAt: now },
          });
          if (count === 0) return false;
          await tx.delivery.updateMany({
            where: { endpointId: id, projectId, status: { in: ["pending", "in_flight"] } },
            data: { status: "cancelled", completedAt: now, lockedBy: null, lockedUntil: null },
          });
          return true;
        });
      },
    },

    deliveries: {
      /** Newest first, keyset-paginated on (created_at, id). */
      async list(projectId: string, filter: DeliveryListFilter): Promise<DeliveryPage> {
        const where: Prisma.DeliveryWhereInput = {
          projectId,
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.endpointId ? { endpointId: filter.endpointId } : {}),
          ...(filter.eventId ? { eventId: filter.eventId } : {}),
          ...(filter.cursor
            ? {
                OR: [
                  { createdAt: { lt: filter.cursor.createdAt } },
                  { createdAt: filter.cursor.createdAt, id: { lt: filter.cursor.id } },
                ],
              }
            : {}),
        };
        const rows = await prisma.delivery.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: filter.limit + 1,
          select: deliverySelect,
        });
        const data = rows.slice(0, filter.limit);
        const last = data[data.length - 1];
        return {
          data,
          nextCursor:
            rows.length > filter.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
        };
      },

      async get(projectId: string, id: string): Promise<DeliveryWithAttempts | null> {
        const row = await prisma.delivery.findFirst({
          where: { id, projectId },
          select: {
            ...deliverySelect,
            attempts: {
              where: { projectId },
              orderBy: { attemptNo: "asc" },
              select: {
                id: true,
                attemptNo: true,
                startedAt: true,
                durationMs: true,
                requestHeaders: true,
                responseStatus: true,
                responseBodySnippet: true,
                error: true,
              },
            },
          },
        });
        if (!row) return null;
        return {
          ...row,
          attempts: row.attempts.map((a) => ({
            ...a,
            requestHeaders: a.requestHeaders as JsonValue,
          })),
        };
      },

      /**
       * Replays one finished delivery (succeeded, failed or dead): back to pending, due now,
       * with the backoff, client-error and reap counters reset (ADR 006). attempt_no in the
       * log keeps increasing. Cancelled deliveries and deliveries of deleted endpoints cannot
       * be replayed.
       */
      async replay(projectId: string, id: string): Promise<ReplayResult> {
        const updated = await prisma.$executeRaw`
          UPDATE deliveries d SET ${replayAssignments}
          FROM endpoints e
          WHERE d.id = ${id}::uuid AND d.project_id = ${projectId}::uuid
            AND e.id = d.endpoint_id AND e.project_id = d.project_id AND e.deleted_at IS NULL
            AND d.status IN ('succeeded', 'failed', 'dead')`;
        const row = await prisma.delivery.findFirst({
          where: { id, projectId },
          select: { ...deliverySelect, endpoint: { select: { deletedAt: true } } },
        });
        if (!row) return { outcome: "not_found" };
        const { endpoint, ...delivery } = row;
        if (updated > 0) return { outcome: "replayed", delivery };
        if (row.status === "cancelled" || endpoint.deletedAt)
          return { outcome: "endpoint_deleted" };
        return { outcome: "in_progress", status: row.status };
      },

      /**
       * Replays up to BULK_REPLAY_CAP finished deliveries matching the filter, oldest first.
       * Deliveries of deleted endpoints are skipped. Returns how many were replayed.
       */
      async bulkReplay(projectId: string, filter: BulkReplayFilter): Promise<number> {
        if (filter.statuses.length === 0) return 0;
        const statuses = Prisma.join(filter.statuses.map((s) => Prisma.sql`${s}::delivery_status`));
        const conditions = [
          Prisma.sql`d.project_id = ${projectId}::uuid`,
          Prisma.sql`d.status IN (${statuses})`,
          Prisma.sql`e.deleted_at IS NULL`,
          ...(filter.endpointId ? [Prisma.sql`d.endpoint_id = ${filter.endpointId}::uuid`] : []),
          ...(filter.from ? [Prisma.sql`d.created_at >= ${filter.from}`] : []),
          ...(filter.to ? [Prisma.sql`d.created_at < ${filter.to}`] : []),
        ];
        return prisma.$executeRaw`
          UPDATE deliveries d SET ${replayAssignments}
          WHERE d.id IN (
            SELECT d.id FROM deliveries d
            JOIN endpoints e ON e.id = d.endpoint_id AND e.project_id = d.project_id
            WHERE ${Prisma.join(conditions, " AND ")}
            ORDER BY d.created_at, d.id
            LIMIT ${BULK_REPLAY_CAP}
            FOR UPDATE OF d SKIP LOCKED
          )`;
      },
    },

    events: {
      /**
       * Accepts an event idempotently, in one transaction (ADR 001, ADR 002).
       *
       * INSERT ... ON CONFLICT DO NOTHING blocks until a concurrent insert of the same key
       * commits or rolls back, so exactly one request creates the event. Under READ COMMITTED
       * the follow-up SELECT then sees the winner's committed row.
       */
      async accept(projectId: string, input: AcceptEventInput): Promise<AcceptEventResult> {
        return prisma.$transaction(async (tx) => {
          const inserted = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO events (project_id, type, payload, idempotency_key, request_hash)
            VALUES (${projectId}::uuid, ${input.type}, ${JSON.stringify(input.payload)}::jsonb,
                    ${input.idempotencyKey}, ${input.requestHash})
            ON CONFLICT (project_id, idempotency_key) DO NOTHING
            RETURNING id::text AS id`;

          const created = inserted[0];
          if (created) {
            const deliveries = await tx.$executeRaw`
              INSERT INTO deliveries (project_id, event_id, endpoint_id, status, next_attempt_at)
              SELECT e.project_id, ${created.id}::uuid, e.id, 'pending', now()
              FROM endpoints e
              WHERE e.project_id = ${projectId}::uuid
                AND e.status = 'active'
                AND e.deleted_at IS NULL
                AND (cardinality(e.event_filter) = 0 OR ${input.type} = ANY (e.event_filter))`;
            return { outcome: "created", eventId: created.id, deliveries };
          }

          const existing = await tx.$queryRaw<
            { id: string; request_hash: string; deliveries: number }[]
          >`
            SELECT ev.id::text AS id, ev.request_hash,
                   (SELECT count(*)::int FROM deliveries d
                     WHERE d.event_id = ev.id AND d.project_id = ev.project_id) AS deliveries
            FROM events ev
            WHERE ev.project_id = ${projectId}::uuid AND ev.idempotency_key = ${input.idempotencyKey}`;
          const row = existing[0];
          if (!row) {
            // Unreachable under READ COMMITTED: the conflicting row is committed.
            throw new Error("idempotency conflict but no existing event found");
          }
          if (row.request_hash !== input.requestHash) {
            return { outcome: "conflict", eventId: row.id };
          }
          return { outcome: "replayed", eventId: row.id, deliveries: row.deliveries };
        });
      },

      async getWithDeliveries(projectId: string, id: string): Promise<EventWithDeliveries | null> {
        const row = await prisma.event.findFirst({
          where: { id, projectId },
          select: {
            id: true,
            projectId: true,
            type: true,
            payload: true,
            idempotencyKey: true,
            createdAt: true,
            deliveries: {
              where: { projectId },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: deliverySelect,
            },
          },
        });
        if (!row) return null;
        return {
          ...row,
          payload: row.payload as JsonValue,
          deliveries: row.deliveries satisfies DeliveryRecord[],
        };
      },
    },
  };
}

export type Repository = ReturnType<typeof createRepository>;

/** Column updates shared by single and bulk replay. */
const replayAssignments = Prisma.sql`
  status = 'pending', next_attempt_at = now(), attempt_count = 0, client_error_count = 0,
  reap_count = 0, completed_at = NULL, locked_by = NULL, locked_until = NULL`;

function toApiKey(row: {
  id: string;
  projectId: string;
  keyPrefix: string;
  keyHash: Uint8Array;
  createdAt: Date;
  revokedAt: Date | null;
}): ApiKeyRecord {
  return { ...row, keyHash: Buffer.from(row.keyHash) };
}

/** Prisma's Bytes type wants a Uint8Array backed by a plain ArrayBuffer. */
function toBytes(buf: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buf);
}
