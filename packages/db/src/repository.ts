import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  AcceptEventInput,
  AcceptEventResult,
  ApiKeyRecord,
  CreateEndpointInput,
  DeliveryRecord,
  EndpointRecord,
  EventWithDeliveries,
  JsonValue,
  ProjectPlan,
  ProjectRecord,
  UpdateEndpointInput,
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
