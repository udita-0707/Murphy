import {
  createDeliveryQueue,
  createPrismaClient,
  runMigrations,
  type PrismaClient,
} from "@murphy/db";
import { randomBytes } from "node:crypto";
import { GenericContainer, Wait } from "testcontainers";
import { percentiles } from "./verify.js";

/**
 * Measures what the endpoint share lock costs a claim (ADR 009), by running the real claim against
 * the same query without the lock, in alternating rounds on the same database so neither gets a
 * warmer cache or a smaller table.
 *
 *   pnpm --filter @murphy/chaos exec tsx src/claim-latency.ts
 */

const PROJECTS = 3;
const ENDPOINTS_PER_PROJECT = 3;
const BACKLOG = 30_000;
const BATCH = 50;
const CAP = 10;
const LEASE_MS = 60_000;
const ROUNDS = 40;
const CLAIMS_PER_ROUND = 25;

/** The claim as it was before the lock. Must otherwise match createDeliveryQueue().claim. */
async function claimWithoutLock(prisma: PrismaClient, workerId: string): Promise<{ id: string }[]> {
  return prisma.$queryRaw<{ id: string }[]>`
    WITH due_projects AS (
      SELECT DISTINCT d.project_id FROM deliveries d
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
        WHERE d.project_id = p.project_id AND d.status = 'pending' AND d.next_attempt_at <= now()
          AND e.status = 'active' AND e.deleted_at IS NULL
        ORDER BY d.next_attempt_at, d.id
        LIMIT ${CAP}
        FOR UPDATE OF d SKIP LOCKED
      ) c
    ),
    picked AS (SELECT id FROM candidates ORDER BY rank, next_attempt_at, id LIMIT ${BATCH})
    UPDATE deliveries d
    SET status = 'in_flight', locked_by = ${workerId},
        locked_until = now() + make_interval(secs => ${LEASE_MS / 1000}),
        claim_token = gen_random_uuid()
    FROM picked WHERE d.id = picked.id
    RETURNING d.id::text AS "id", d.project_id::text AS "projectId",
              d.event_id::text AS "eventId", d.endpoint_id::text AS "endpointId",
              d.status::text AS "status", d.attempt_count AS "attemptCount",
              d.next_attempt_at AS "nextAttemptAt", d.locked_by AS "lockedBy",
              d.locked_until AS "lockedUntil", d.claim_token::text AS "claimToken"`;
}

async function seed(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRaw`TRUNCATE projects CASCADE`;
  for (let p = 0; p < PROJECTS; p++) {
    const project = await prisma.project.create({ data: { name: `p${p}` } });
    const event = await prisma.event.create({
      data: {
        projectId: project.id,
        type: "x",
        payload: {},
        idempotencyKey: `k${p}`,
        requestHash: "h",
      },
    });
    for (let e = 0; e < ENDPOINTS_PER_PROJECT; e++) {
      const endpoint = await prisma.endpoint.create({
        data: {
          projectId: project.id,
          url: "https://example.com/hook",
          secretEnc: new Uint8Array(randomBytes(48)),
        },
      });
      const rows = Math.floor(BACKLOG / (PROJECTS * ENDPOINTS_PER_PROJECT));
      await prisma.$executeRaw`
        INSERT INTO deliveries (project_id, event_id, endpoint_id, status, next_attempt_at)
        SELECT ${project.id}::uuid, ${event.id}::uuid, ${endpoint.id}::uuid, 'pending',
               now() - interval '1 hour' + (g * interval '1 millisecond')
        FROM generate_series(1, ${rows}) AS g`;
    }
  }
  await prisma.$executeRawUnsafe(`VACUUM ANALYZE deliveries`);
}

/** Puts claimed rows back, so every round sees the same backlog. */
const reset = (prisma: PrismaClient) =>
  prisma.$executeRaw`
    UPDATE deliveries SET status = 'pending', locked_by = NULL, locked_until = NULL,
      claim_token = NULL WHERE status = 'in_flight'`;

interface Scenario {
  name: string;
  /** Claimers running at once, like several workers. */
  claimers: number;
  /** Writers taking the same endpoint locks at the same time, like live ingestion. */
  ingesters: number;
}

const SCENARIOS: Scenario[] = [
  { name: "one claimer, no other load", claimers: 1, ingesters: 0 },
  { name: "three claimers", claimers: 3, ingesters: 0 },
  { name: "three claimers, with live ingestion", claimers: 3, ingesters: 8 },
];

async function run(prisma: PrismaClient, scenario: Scenario) {
  const queue = createDeliveryQueue(prisma);
  const endpoints = await prisma.endpoint.findMany({ select: { projectId: true } });
  const projects = [...new Set(endpoints.map((e) => e.projectId))];
  const times: Record<"with lock" | "without lock", number[]> = {
    "with lock": [],
    "without lock": [],
  };
  let key = 0;

  for (let round = 0; round < ROUNDS; round++) {
    // Alternates which goes first, so neither is favoured by order.
    const order =
      round % 2 === 0
        ? (["with lock", "without lock"] as const)
        : (["without lock", "with lock"] as const);
    for (const variant of order) {
      await reset(prisma);
      let stop = false;
      const ingesters = Array.from({ length: scenario.ingesters }, async (_, i) => {
        while (!stop) {
          await prisma.$executeRaw`
            WITH ev AS (
              INSERT INTO events (project_id, type, payload, idempotency_key, request_hash)
              VALUES (${projects[i % projects.length]!}::uuid, 'x', '{}'::jsonb, ${`load-${key++}`}, 'h')
              RETURNING id, project_id
            ),
            targets AS (
              SELECT e.id, e.project_id FROM endpoints e
              WHERE e.project_id = ${projects[i % projects.length]!}::uuid AND e.status = 'active'
              FOR SHARE OF e
            )
            INSERT INTO deliveries (project_id, event_id, endpoint_id, status, next_attempt_at)
            SELECT t.project_id, ev.id, t.id, 'pending', now() + interval '1 day'
            FROM targets t CROSS JOIN ev`;
        }
      });
      const claimers = Array.from({ length: scenario.claimers }, async (_, c) => {
        for (let i = 0; i < CLAIMS_PER_ROUND; i++) {
          const started = performance.now();
          if (variant === "with lock") {
            await queue.claim({
              workerId: `w${c}`,
              batchSize: BATCH,
              projectCap: CAP,
              leaseMs: LEASE_MS,
            });
          } else {
            await claimWithoutLock(prisma, `w${c}`);
          }
          times[variant].push(performance.now() - started);
        }
      });
      await Promise.all(claimers);
      stop = true;
      await Promise.all(ingesters);
    }
  }
  return times;
}

async function main(): Promise<void> {
  const password = randomBytes(16).toString("hex");
  const container = await new GenericContainer("postgres:16")
    .withEnvironment({ POSTGRES_USER: "bench", POSTGRES_PASSWORD: password, POSTGRES_DB: "bench" })
    .withExposedPorts(5432)
    .withHealthCheck({
      test: ["CMD-SHELL", "pg_isready -h localhost -U bench -d bench"],
      interval: 250,
      timeout: 1000,
      retries: 240,
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .start();
  const url = `postgresql://bench:${password}@127.0.0.1:${container.getMappedPort(5432)}/bench`;
  const prisma = createPrismaClient(url);
  try {
    runMigrations(url);
    await seed(prisma);
    console.log(
      `${BACKLOG} pending deliveries, ${PROJECTS} projects, ${PROJECTS * ENDPOINTS_PER_PROJECT} endpoints, batch ${BATCH}, cap ${CAP}\n`,
    );
    for (const scenario of SCENARIOS) {
      const times = await run(prisma, scenario);
      const withLock = percentiles(times["with lock"]);
      const without = percentiles(times["without lock"]);
      const fmt = (n: number | null) => (n === null ? "n/a" : `${n.toFixed(2)} ms`);
      const change = (a: number | null, b: number | null) =>
        a === null || b === null ? "n/a" : `${(((a - b) / b) * 100).toFixed(1)}%`;
      console.log(scenario.name);
      console.log(
        `  without lock: n=${without.count} p50 ${fmt(without.p50)} p95 ${fmt(without.p95)}`,
      );
      console.log(
        `  with lock:    n=${withLock.count} p50 ${fmt(withLock.p50)} p95 ${fmt(withLock.p95)}`,
      );
      console.log(
        `  change:       p50 ${change(withLock.p50, without.p50)} p95 ${change(withLock.p95, without.p95)}\n`,
      );
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
    await container.stop({ timeout: 0 }).catch(() => undefined);
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
