import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { randomBytes, randomUUID } from "node:crypto";
import { createPrismaClient, runMigrations, type PrismaClient } from "@murphy/db";

export interface TestDb {
  container: StartedPostgreSqlContainer;
  prisma: PrismaClient;
  url: string;
  stop: () => Promise<void>;
}

/** Starts a real Postgres 16 with all migrations applied. */
export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer("postgres:16").start();
  const url = container.getConnectionUri();
  runMigrations(url);
  const prisma = createPrismaClient(url);
  return {
    container,
    prisma,
    url,
    stop: async () => {
      await prisma.$disconnect();
      await container.stop();
    },
  };
}

export interface Fixture {
  projectId: string;
  endpointId: string;
  eventId: string;
}

/** A project with one endpoint and one event, written directly for queue tests. */
export async function createFixture(
  prisma: PrismaClient,
  endpoint: { url?: string; status?: "active" | "disabled" | "paused"; secretEnc?: Buffer } = {},
): Promise<Fixture> {
  const project = await prisma.project.create({ data: { name: `p-${randomUUID()}` } });
  const ep = await prisma.endpoint.create({
    data: {
      projectId: project.id,
      url: endpoint.url ?? "https://example.com/hooks",
      secretEnc: new Uint8Array(endpoint.secretEnc ?? randomBytes(48)),
      status: endpoint.status ?? "active",
    },
  });
  const event = await prisma.event.create({
    data: {
      projectId: project.id,
      type: "payment.captured",
      payload: { id: "pay_1", amount: 49900 },
      idempotencyKey: randomUUID(),
      requestHash: "x",
    },
  });
  return { projectId: project.id, endpointId: ep.id, eventId: event.id };
}

/** Inserts `count` pending deliveries for the fixture, due `offsetMs` from now (default: due). */
export async function insertDeliveries(
  prisma: PrismaClient,
  f: Fixture,
  count: number,
  offsetMs = -1_000,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO deliveries (project_id, event_id, endpoint_id, status, next_attempt_at)
    SELECT ${f.projectId}::uuid, ${f.eventId}::uuid, ${f.endpointId}::uuid, 'pending',
           now() + make_interval(secs => ${offsetMs / 1000}) + (g * interval '1 millisecond')
    FROM generate_series(1, ${count}) AS g`;
}
