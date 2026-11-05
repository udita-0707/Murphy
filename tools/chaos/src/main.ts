import { canonicalHash } from "@murphy/core";
import { createPrismaClient, runMigrations, type PrismaClient } from "@murphy/db";
import { auditViolations, installDeliveryAudit } from "@murphy/db/audit";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { sendEvent } from "./load.js";
import { makePlan, planHash } from "./plan.js";
import { Processes, REPO_ROOT, type Managed } from "./procs.js";
import { buildReport, renderRunReport, verdict } from "./report.js";
import { expectedFailure, isSabotage, sabotage, type SabotageMode } from "./sabotage.js";
import type {
  ChaosPlan,
  ClientRecord,
  ControlRecord,
  DbSnapshot,
  PlanFault,
  ReceiverRecord,
  RunData,
} from "./types.js";
import { verifyRun } from "./verify.js";

const DRAIN_TIMEOUT_MS = 300_000;
const QUIET_MS = 10_000;
const CLIENT_DEADLINE_AFTER_LOAD_MS = 120_000;
const API_RETRY_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv: string[]) {
  const options: {
    seed?: number;
    events?: number;
    rate?: number;
    workers?: number;
    out?: string;
    sabotage?: SabotageMode;
  } = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    const number = () => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} needs a non-negative integer`);
      i += 1;
      return n;
    };
    switch (flag) {
      case "--":
        break;
      case "--seed":
        options.seed = number();
        break;
      case "--events":
        options.events = number();
        break;
      case "--rate":
        options.rate = number();
        break;
      case "--workers":
        options.workers = number();
        break;
      case "--out":
        options.out = value;
        i += 1;
        break;
      case "--sabotage":
        if (!isSabotage(value)) throw new Error(`--sabotage must be lost-event or fake-success`);
        options.sabotage = value;
        i += 1;
        break;
      default:
        throw new Error(`unknown option ${flag}`);
    }
  }
  return options;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function jsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

/** Retries a harness query while Postgres is restarting. */
async function retrying<T>(what: string, run: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await run();
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`${what} kept failing: ${String(err)}`);
      await sleep(API_RETRY_MS);
    }
  }
}

const postmasterStart = async (prisma: PrismaClient) =>
  (
    await prisma.$queryRaw<{ started: Date }[]>`SELECT pg_postmaster_start_time() AS started`
  )[0]!.started.toISOString();

async function snapshot(prisma: PrismaClient): Promise<DbSnapshot> {
  const events = await prisma.event.findMany({
    select: { id: true, projectId: true, idempotencyKey: true, type: true, payload: true },
  });
  const deliveries = await prisma.delivery.findMany({
    select: {
      id: true,
      eventId: true,
      endpointId: true,
      projectId: true,
      status: true,
      attemptCount: true,
      reapCount: true,
      lockedBy: true,
      lockedUntil: true,
      claimToken: true,
    },
  });
  const endpoints = await prisma.endpoint.findMany({
    select: { id: true, status: true, deletedAt: true },
  });
  const attemptRows = await prisma.deliveryAttempt.count();
  const leases = await prisma.$queryRaw<{ worker: string; count: number }[]>`
    SELECT request_headers->>'x-murphy-worker' AS worker, count(*)::int AS count
    FROM delivery_attempts WHERE error LIKE 'lease_expired%' GROUP BY 1`;
  return {
    events: events.map(({ payload, ...e }) => ({ ...e, payloadHash: canonicalHash(payload) })),
    deliveries: deliveries.map((d) => ({
      ...d,
      lockedUntil: d.lockedUntil?.toISOString() ?? null,
    })),
    endpoints: endpoints.map((e) => ({
      id: e.id,
      status: e.status,
      deleted: e.deletedAt !== null,
    })),
    attemptRows,
    leaseExpiredByWorker: Object.fromEntries(leases.map((l) => [l.worker, l.count])),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const seed = args.seed ?? Math.floor(Math.random() * 1_000_000);
  const plan: ChaosPlan = makePlan({
    seed,
    ...(args.events !== undefined ? { events: args.events } : {}),
    ...(args.rate !== undefined ? { rate: args.rate } : {}),
    ...(args.workers !== undefined ? { workers: args.workers } : {}),
  });
  const startedAt = new Date();
  const label = `${seed}-${startedAt.toISOString().replaceAll(/[:.]/g, "-")}`;
  const outDir = path.resolve(args.out ?? path.join(REPO_ROOT, ".chaos", label));
  mkdirSync(outDir, { recursive: true });
  const say = (message: string) => console.log(`[chaos ${seed}] ${message}`);

  say(
    `seed ${seed}, plan ${planHash(plan)}: ${plan.events.length} events, ${plan.faults.length} planned actions`,
  );
  say(`output in ${outDir}`);

  const clientPath = path.join(outDir, "client.jsonl");
  const controlPath = path.join(outDir, "control.jsonl");
  const receiverPath = path.join(outDir, "receiver.jsonl");
  for (const file of [clientPath, controlPath, receiverPath]) writeFileSync(file, "");
  const logClient = (record: ClientRecord) =>
    appendFileSync(clientPath, JSON.stringify(record) + "\n");
  const logControl = (
    action: string,
    phase: ControlRecord["phase"],
    target?: string,
    detail?: string,
  ) => {
    const record: ControlRecord = {
      t: Date.now(),
      action,
      phase,
      ...(target ? { target } : {}),
      ...(detail ? { detail } : {}),
    };
    appendFileSync(controlPath, JSON.stringify(record) + "\n");
  };

  // Postgres, on a fixed host port because a restart may otherwise change the mapped one.
  const dbPort = await freePort();
  const password = randomBytes(16).toString("hex");
  say("starting Postgres");
  const container: StartedTestContainer = await new GenericContainer("postgres:16")
    .withEnvironment({ POSTGRES_USER: "chaos", POSTGRES_PASSWORD: password, POSTGRES_DB: "chaos" })
    .withExposedPorts({ container: 5432, host: dbPort })
    // Durability on, explicitly, and recorded in the report.
    .withCommand([
      "postgres",
      "-c",
      "fsync=on",
      "-c",
      "synchronous_commit=on",
      "-c",
      "max_connections=200",
    ])
    .withHealthCheck({
      test: ["CMD-SHELL", "pg_isready -h localhost -U chaos -d chaos"],
      interval: 250,
      timeout: 1000,
      retries: 240,
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .start();

  const databaseUrl = `postgresql://chaos:${password}@127.0.0.1:${dbPort}/chaos`;
  const procs = new Processes(outDir);
  const prisma = createPrismaClient(databaseUrl);
  let exitCode = 1;

  try {
    runMigrations(databaseUrl);
    await installDeliveryAudit(prisma);
    const settings = Object.fromEntries(
      await Promise.all(
        ["fsync", "synchronous_commit", "server_version"].map(async (name) => {
          const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(
            `SELECT current_setting('${name}') AS value`,
          );
          return [name, rows[0]!.value];
        }),
      ),
    ) as Record<string, string>;
    const postmasterStarts = [await postmasterStart(prisma)];

    const encryptionKey = randomBytes(32).toString("base64");
    const baseEnv = {
      DATABASE_URL: databaseUrl,
      MURPHY_ENCRYPTION_KEY: encryptionKey,
      MURPHY_MODE: "local",
    };

    // The API.
    const apiPort = await freePort();
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    let apiGeneration = 0;
    const startApi = () =>
      procs.start({
        name: `api.${apiGeneration++}`,
        cwd: "apps/api",
        script: "src/server.ts",
        env: { ...baseEnv, PORT: String(apiPort) },
      });
    let api: Managed = startApi();

    // The receiver.
    const receiver = procs.start({
      name: "receiver",
      cwd: "tools/chaos",
      script: "src/receiver.ts",
      pipeStdout: true,
      env: {
        CHAOS_RECEIVER_CONFIG: JSON.stringify({
          seed,
          goneAfter: plan.goneAfter,
          logPath: receiverPath,
          endpoints: plan.endpoints.map((e) => ({ key: e.key, profile: e.profile })),
        }),
      },
    });
    const receiverPort = await new Promise<number>((resolve, reject) => {
      const lines = createInterface({ input: receiver.child.stdout! });
      lines.once("line", (line) => resolve((JSON.parse(line) as { port: number }).port));
      receiver.child.once("exit", () => reject(new Error("the receiver did not start")));
    });
    const receiverUrl = `http://127.0.0.1:${receiverPort}`;

    await retrying("API health check", async () => {
      const response = await fetch(`${apiUrl}/healthz`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    });

    // Tenants, through the same seed script a developer uses, then the public API.
    say("creating projects and endpoints");
    const apiKeys: Record<string, string> = {};
    const projectIds: Record<string, string> = {};
    for (const projectKey of plan.projects) {
      const seeded = spawnSync(process.execPath, ["--import", "tsx", "src/seed.ts", projectKey], {
        cwd: path.join(REPO_ROOT, "apps/api"),
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...baseEnv },
      });
      const id = /\(([0-9a-f-]{36})\)/.exec(seeded.stdout)?.[1];
      const key = /(mk_\S+)/.exec(seeded.stdout)?.[1];
      if (!id || !key) throw new Error(`seeding ${projectKey} failed: ${seeded.stderr}`);
      projectIds[projectKey] = id;
      apiKeys[projectKey] = key;
    }

    const apiCall = async (projectKey: string, method: string, route: string, body?: unknown) => {
      const response = await fetch(`${apiUrl}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${apiKeys[projectKey]}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status}`);
      return response.status === 204 ? null : ((await response.json()) as Record<string, unknown>);
    };

    const endpointIds: Record<string, string> = {};
    for (const endpoint of plan.endpoints) {
      const created = await apiCall(endpoint.projectKey, "POST", "/v1/endpoints", {
        url: `${receiverUrl}/hook/${endpoint.key}`,
        event_filter: endpoint.filter,
      });
      endpointIds[endpoint.key] = created!.id as string;
      const registered = await fetch(`${receiverUrl}/_register`, {
        method: "POST",
        body: JSON.stringify({ key: endpoint.key, secret: created!.secret }),
      });
      if (!registered.ok) throw new Error("could not register a secret with the receiver");
    }

    // The workers. Each incarnation has its own id, so the report can say what each kill left.
    const workerGeneration = new Array<number>(plan.workers).fill(0);
    const workerId = (slot: number) => `w${slot}.${workerGeneration[slot]}`;
    const startWorker = (slot: number) =>
      procs.start({
        name: `worker-${workerId(slot)}`,
        cwd: "apps/worker",
        script: "src/main.ts",
        env: {
          ...baseEnv,
          WORKER_ID: workerId(slot),
          WORKER_POLL_MS: "100",
          WORKER_LEASE_MS: String(plan.leaseMs),
          WORKER_REQUEST_TIMEOUT_MS: String(plan.requestTimeoutMs),
          WORKER_REAP_INTERVAL_MS: "1000",
          WORKER_SHUTDOWN_TIMEOUT_MS: "3000",
          WORKER_RETRY_SCHEDULE_MS: plan.retryScheduleMs.join(","),
        },
      });
    const workers: Managed[] = [];
    for (let slot = 0; slot < plan.workers; slot++) workers.push(startWorker(slot));
    const respawns: Promise<void>[] = [];
    let postgresRestarts: Promise<void> = Promise.resolve();

    // Faults run on their own clock, independently of the load.
    const runFault = async (fault: PlanFault): Promise<void> => {
      switch (fault.action) {
        case "kill_worker": {
          const slot = fault.worker;
          const id = workerId(slot);
          logControl("kill_worker", "start", id, `pid ${workers[slot]!.child.pid}`);
          await procs.kill(workers[slot]!);
          logControl("kill_worker", "done", id);
          say(`killed worker ${id}`);
          respawns.push(
            sleep(fault.respawnMs).then(() => {
              workerGeneration[slot]! += 1;
              workers[slot] = startWorker(slot);
              logControl("respawn_worker", "start", workerId(slot));
            }),
          );
          return;
        }
        case "kill_api": {
          logControl("kill_api", "start", undefined, `pid ${api.child.pid}`);
          await procs.kill(api);
          logControl("kill_api", "done");
          say("killed the API");
          respawns.push(
            sleep(fault.respawnMs).then(() => {
              api = startApi();
              logControl("respawn_api", "start");
            }),
          );
          return;
        }
        case "restart_postgres": {
          // One at a time: a restart during a restart would not be a second crash.
          const run = async () => {
            logControl("restart_postgres", "start");
            say("killing and restarting Postgres");
            await container.restart({ timeout: 0 });
            const started = await retrying("Postgres after restart", () => postmasterStart(prisma));
            postmasterStarts.push(started);
            logControl("restart_postgres", "done", undefined, started);
            say("Postgres is back");
          };
          postgresRestarts = postgresRestarts.then(run);
          await postgresRestarts;
          return;
        }
        case "disable_endpoint":
        case "enable_endpoint": {
          const endpoint = plan.endpoints.find((e) => e.key === fault.endpoint)!;
          const status = fault.action === "enable_endpoint" ? "active" : "disabled";
          logControl(fault.action, "start", endpoint.key);
          await retrying(fault.action, () =>
            apiCall(endpoint.projectKey, "PATCH", `/v1/endpoints/${endpointIds[endpoint.key]}`, {
              status,
            }),
          );
          logControl(fault.action, "done", endpoint.key);
          say(`${fault.action} ${endpoint.key}`);
          return;
        }
        case "delete_endpoint": {
          const endpoint = plan.endpoints.find((e) => e.key === fault.endpoint)!;
          logControl("delete_endpoint", "start", endpoint.key);
          await retrying("delete_endpoint", async () => {
            try {
              await apiCall(
                endpoint.projectKey,
                "DELETE",
                `/v1/endpoints/${endpointIds[endpoint.key]}`,
              );
            } catch (err) {
              // A retry after an unacknowledged success finds it already gone.
              if (!String(err).includes("HTTP 404")) throw err;
            }
          });
          logControl("delete_endpoint", "done", endpoint.key);
          say(`deleted ${endpoint.key}`);
          return;
        }
      }
    };

    // Run.
    say(`load starting: ${plan.events.length} events over ${plan.loadMs / 1000} s`);
    const loadStartedAt = Date.now();
    const deadline = loadStartedAt + plan.loadMs + CLIENT_DEADLINE_AFTER_LOAD_MS;
    const at = (ms: number) => sleep(Math.max(0, loadStartedAt + ms - Date.now()));

    const faults = plan.faults.map(async (fault) => {
      await at(fault.atMs);
      await runFault(fault);
    });
    const load = plan.events.map(async (event) => {
      await at(event.atMs);
      await sendEvent({
        apiUrl: () => apiUrl,
        apiKey: apiKeys[event.projectKey]!,
        event,
        deadline,
        log: logClient,
      });
    });

    let sabotageDetail: string | null = null;
    const sabotageRun = args.sabotage
      ? (async () => {
          await at(plan.loadMs * 0.5);
          sabotageDetail = await retrying("sabotage", () =>
            sabotage(prisma, args.sabotage!, jsonl<ClientRecord>(clientPath), endpointIds),
          );
          logControl("sabotage", "start", args.sabotage, sabotageDetail);
          say(`SABOTAGE ${args.sabotage}: ${sabotageDetail}`);
        })()
      : Promise.resolve();

    await Promise.all(load);
    say("load finished");
    await Promise.all(faults);
    await sabotageRun;
    await Promise.all(respawns);

    // Quiet period.
    say("draining: waiting for delivery work to finish");
    const drainStarted = Date.now();
    let drainTimedOut = false;
    let lastFingerprint = "";
    let lastChange = Date.now();
    for (;;) {
      const rows = await retrying(
        "drain query",
        () =>
          prisma.$queryRaw<{ active: number; fingerprint: string }[]>`
          SELECT
            (SELECT count(*)::int FROM deliveries d JOIN endpoints e ON e.id = d.endpoint_id
              WHERE d.status = 'in_flight'
                 OR (d.status = 'pending' AND e.status = 'active' AND e.deleted_at IS NULL)) AS active,
            (SELECT count(*)::text FROM delivery_attempts) || '/' ||
            (SELECT COALESCE(string_agg(s, ','), '') FROM (
              SELECT status::text || count(*) AS s FROM deliveries GROUP BY status ORDER BY status
            ) x) AS fingerprint`,
      );
      const { active, fingerprint } = rows[0]!;
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        lastChange = Date.now();
      }
      if (active === 0 && Date.now() - lastChange >= QUIET_MS) break;
      if (Date.now() - drainStarted > DRAIN_TIMEOUT_MS) {
        drainTimedOut = true;
        say(`drain timed out with ${active} deliveries still active`);
        break;
      }
      await sleep(1000);
    }
    const drainSeconds = Math.round((Date.now() - drainStarted) / 1000);
    say(`quiet after ${drainSeconds} s`);

    // Read every source, then judge.
    const db = await snapshot(prisma);
    const audit = await auditViolations(prisma, 20);
    for (const worker of workers) await procs.stop(worker);
    await procs.stop(api);
    await procs.stop(receiver);

    const data: RunData = {
      plan,
      projectIds,
      endpointIds,
      client: jsonl<ClientRecord>(clientPath),
      control: jsonl<ControlRecord>(controlPath),
      receiver: jsonl<ReceiverRecord>(receiverPath),
      db,
      audit: {
        total: audit.total,
        rowsChecked: audit.rowsChecked,
        examples: audit.violations.map((v) => ({
          rule: v.rule,
          deliveryId: v.deliveryId,
          detail: v.detail,
        })),
      },
      unexpectedExits: procs.unexpectedExits,
      drainTimedOut,
      postmasterStarts,
    };
    const result = verifyRun(data);
    const report = buildReport(
      {
        seed,
        plan,
        startedAt: startedAt.toISOString(),
        durationSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
        drainSeconds,
        settings,
        control: data.control,
        loadStartedAt,
        sabotage: args.sabotage ?? null,
        sabotageDetail,
        unexpectedExits: procs.unexpectedExits,
        drainTimedOut,
      },
      result,
    );
    writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
    writeFileSync(path.join(outDir, "report.md"), renderRunReport(report));

    for (const invariant of result.invariants) {
      say(`${invariant.status.toUpperCase().padEnd(4)} ${invariant.id} ${invariant.title}`);
      for (const example of invariant.examples) say(`       ${example}`);
    }
    for (const e of result.effects.filter((x) => !x.ok))
      say(`NO EFFECT: ${e.name} (${e.evidence})`);
    for (const line of procs.unexpectedExits) say(`UNEXPECTED: ${line}`);
    say(`duplicates seen by a naive receiver: ${result.duplicates.total}`);
    say(`report: ${path.join(outDir, "report.md")}`);
    say(`RESULT: ${verdict(report)} (seed ${seed})`);

    if (args.sabotage) {
      const expected = expectedFailure(args.sabotage);
      const failed = result.invariants.find((i) => i.id === expected)?.status === "fail";
      say(
        `negative control ${args.sabotage}: ${expected} ${failed ? "failed, as it must" : "DID NOT FAIL"}`,
      );
      exitCode = failed ? 0 : 1;
    } else {
      exitCode = result.passed ? 0 : 1;
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
    await container.stop({ timeout: 0 }).catch(() => undefined);
  }
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
