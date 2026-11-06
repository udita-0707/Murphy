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
  type EventListFilter,
  type EventPage,
  type EventWithDeliveries,
  type JsonValue,
  type ProjectPlan,
  type ProjectRecord,
  type ReplayResult,
  type RunDelivery,
  type RunRecord,
  type SaveScenarioInput,
  type ScenarioRecord,
  type StartRunInput,
  type StartRunResult,
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
            data: {
              status: "cancelled",
              completedAt: now,
              lockedBy: null,
              lockedUntil: null,
              claimToken: null,
            },
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
          ...(filter.simulated === undefined
            ? {}
            : { event: { projectId, scenarioRunId: filter.simulated ? { not: null } : null } }),
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
          select: { ...deliverySelect, event: { select: { type: true, scenarioRunId: true } } },
        });
        const page = rows.slice(0, filter.limit);
        const last = page[page.length - 1];
        return {
          data: page.map(({ event, ...delivery }) => ({
            ...delivery,
            eventType: event.type,
            simulated: event.scenarioRunId !== null,
          })),
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
       * be replayed. The endpoint row is locked FOR SHARE, for the same reason as in accept.
       */
      async replay(projectId: string, id: string): Promise<ReplayResult> {
        const updated = await prisma.$executeRaw`
          WITH live AS (
            SELECT e.id FROM endpoints e
            JOIN deliveries d ON d.endpoint_id = e.id AND d.project_id = e.project_id
            WHERE d.id = ${id}::uuid AND d.project_id = ${projectId}::uuid AND e.deleted_at IS NULL
            FOR SHARE OF e
          )
          UPDATE deliveries d SET ${replayAssignments}
          FROM live
          WHERE d.id = ${id}::uuid AND d.project_id = ${projectId}::uuid
            AND d.endpoint_id = live.id
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
            FOR SHARE OF e
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
       *
       * Fan-out locks the endpoint rows FOR SHARE so it cannot interleave with a delete (ADR 009):
       * otherwise a delivery could commit after the delete's sweep and wait forever.
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
                AND (cardinality(e.event_filter) = 0 OR ${input.type} = ANY (e.event_filter))
              FOR SHARE OF e`;
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

      /** Newest first, keyset-paginated on (created_at, id). */
      async list(projectId: string, filter: EventListFilter): Promise<EventPage> {
        const rows = await prisma.event.findMany({
          where: {
            projectId,
            ...(filter.simulated === undefined
              ? {}
              : { scenarioRunId: filter.simulated ? { not: null } : null }),
            ...(filter.cursor
              ? {
                  OR: [
                    { createdAt: { lt: filter.cursor.createdAt } },
                    { createdAt: filter.cursor.createdAt, id: { lt: filter.cursor.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: filter.limit + 1,
          select: {
            id: true,
            type: true,
            idempotencyKey: true,
            createdAt: true,
            scenarioRunId: true,
            _count: { select: { deliveries: { where: { projectId } } } },
          },
        });
        const page = rows.slice(0, filter.limit);
        const last = page[page.length - 1];
        return {
          data: page.map(({ _count, ...event }) => ({
            ...event,
            deliveryCount: _count.deliveries,
          })),
          nextCursor:
            rows.length > filter.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
        };
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
            scenarioRunId: true,
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

    scenarios: {
      /** Creates or replaces this project's scenario with that slug. Past runs keep their own plan. */
      async save(projectId: string, input: SaveScenarioInput): Promise<ScenarioRecord> {
        return prisma.scenario.upsert({
          where: { projectId_slug: { projectId, slug: input.slug } },
          create: { projectId, ...input },
          update: input,
        });
      },

      /** The project's own scenarios and the public built-ins. */
      async list(projectId: string): Promise<ScenarioRecord[]> {
        return prisma.scenario.findMany({
          where: { OR: [{ projectId }, { projectId: null, isPublic: true }] },
          orderBy: [{ slug: "asc" }, { id: "asc" }],
        });
      },

      async get(projectId: string, id: string): Promise<ScenarioRecord | null> {
        return prisma.scenario.findFirst({
          where: { id, OR: [{ projectId }, { projectId: null, isPublic: true }] },
        });
      },

      /** Installs the built-in library. Not tenant data: built-ins have no project. */
      async syncBuiltins(inputs: SaveScenarioInput[]): Promise<void> {
        for (const s of inputs) {
          await prisma.$executeRaw`
            INSERT INTO scenarios (slug, name, difficulty, definition_yaml, is_public)
            VALUES (${s.slug}, ${s.name}, ${s.difficulty}::scenario_difficulty, ${s.definitionYaml}, true)
            ON CONFLICT (slug) WHERE project_id IS NULL DO UPDATE
            SET name = EXCLUDED.name, difficulty = EXCLUDED.difficulty,
                definition_yaml = EXCLUDED.definition_yaml, is_public = true`;
        }
      },
    },

    runs: {
      /**
       * Starts a simulator run in one transaction: the run, its entities, and ordinary events and
       * delivery rows for this one endpoint, due in the future (ADR 011). The real worker does the
       * rest. It does not fan out, so a project's real endpoints never see simulated events.
       *
       * The endpoint is locked FOR SHARE so a delete cannot strand a row (ADR 009). Waits are bounded
       * by the transaction timeout, which allows for a scenario's largest size.
       */
      async start(projectId: string, input: StartRunInput): Promise<StartRunResult> {
        return prisma.$transaction(
          async (tx) => {
            const scenario = await tx.scenario.findFirst({
              where: {
                id: input.scenarioId,
                OR: [{ projectId }, { projectId: null, isPublic: true }],
              },
              select: { id: true },
            });
            if (!scenario) return { outcome: "scenario_not_found" };

            const endpoint = await tx.$queryRaw<{ id: string }[]>`
              SELECT id::text FROM endpoints
              WHERE id = ${input.endpointId}::uuid AND project_id = ${projectId}::uuid
                AND status = 'active' AND deleted_at IS NULL
              FOR SHARE`;
            if (endpoint.length === 0) return { outcome: "endpoint_not_available" };

            await tx.$executeRaw`
              INSERT INTO scenario_runs (id, project_id, scenario_id, endpoint_id, status, started_at,
                                         seed, target_label, state_url, deadline_at, plan)
              VALUES (${input.id}::uuid, ${projectId}::uuid, ${input.scenarioId}::uuid,
                      ${input.endpointId}::uuid, 'running', now(), ${input.seed}, ${input.targetLabel},
                      ${input.stateUrl}, now() + make_interval(secs => ${input.deadlineOffsetMs / 1000}),
                      ${JSON.stringify(input.plan)}::jsonb)`;

            for (const step of input.steps) {
              const inserted = await tx.$queryRaw<{ id: string }[]>`
                INSERT INTO events (project_id, type, payload, idempotency_key, request_hash, scenario_run_id)
                VALUES (${projectId}::uuid, ${step.eventType}, ${JSON.stringify(step.payload)}::jsonb,
                        ${step.idempotencyKey}, ${step.requestHash}, ${input.id}::uuid)
                RETURNING id::text AS id`;
              const eventId = inserted[0]!.id;
              for (const offset of step.dueOffsetsMs) {
                await tx.$executeRaw`
                  INSERT INTO deliveries (project_id, event_id, endpoint_id, status, next_attempt_at)
                  VALUES (${projectId}::uuid, ${eventId}::uuid, ${input.endpointId}::uuid, 'pending',
                          now() + make_interval(secs => ${offset / 1000}))`;
              }
            }

            await tx.simulatedEntity.createMany({
              data: input.entities.map((e) => ({ ...e, runId: input.id, projectId })),
            });
            return { outcome: "started", runId: input.id };
          },
          { timeout: 15_000 },
        );
      },

      async get(projectId: string, id: string): Promise<RunRecord | null> {
        const row = await prisma.scenarioRun.findFirst({
          where: { id, projectId },
          select: {
            id: true,
            projectId: true,
            scenarioId: true,
            endpointId: true,
            status: true,
            seed: true,
            targetLabel: true,
            stateUrl: true,
            plan: true,
            report: true,
            startedAt: true,
            finishedAt: true,
            deadlineAt: true,
            createdAt: true,
          },
        });
        return row
          ? { ...row, plan: row.plan as JsonValue, report: row.report as JsonValue }
          : null;
      },

      /** A run's delivery rows and attempts, without request headers (they hold signatures). */
      async deliveries(projectId: string, runId: string): Promise<RunDelivery[]> {
        const rows = await prisma.delivery.findMany({
          where: { projectId, event: { projectId, scenarioRunId: runId } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            eventId: true,
            status: true,
            createdAt: true,
            event: { select: { payload: true } },
            attempts: {
              where: { projectId },
              orderBy: { attemptNo: "asc" },
              select: {
                attemptNo: true,
                startedAt: true,
                durationMs: true,
                responseStatus: true,
                error: true,
              },
            },
          },
        });
        return rows.map((r) => ({
          deliveryId: r.id,
          eventId: r.eventId,
          step: (r.event.payload as { _murphy?: { step?: string } })._murphy?.step ?? "",
          status: r.status,
          createdAt: r.createdAt,
          attempts: r.attempts,
        }));
      },
    },
  };
}

export type Repository = ReturnType<typeof createRepository>;

/** Column updates shared by single and bulk replay. */
const replayAssignments = Prisma.sql`
  status = 'pending', next_attempt_at = now(), attempt_count = 0, client_error_count = 0,
  reap_count = 0, completed_at = NULL, locked_by = NULL, locked_until = NULL, claim_token = NULL`;

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
