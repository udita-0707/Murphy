import { createPrismaClient, runMigrations } from "@murphy/db";
import autocannon from "autocannon";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { GenericContainer, Wait } from "testcontainers";
import { Processes, REPO_ROOT } from "./procs.js";

/**
 * A small local baseline of ingestion throughput: one API process and a real Postgres, with no
 * workers, so it measures POST /v1/events only. This is not the benchmark (that is phase 6).
 *
 *   pnpm load [--seconds 60] [--connections 20]
 */

function option(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} needs a positive integer`);
  return value;
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

async function main(): Promise<void> {
  const seconds = option("seconds", 60);
  const connections = option("connections", 20);
  const outDir = path.join(REPO_ROOT, ".chaos", `load-${Date.now()}`);
  mkdirSync(outDir, { recursive: true });

  const password = randomBytes(16).toString("hex");
  const container = await new GenericContainer("postgres:16")
    .withEnvironment({ POSTGRES_USER: "load", POSTGRES_PASSWORD: password, POSTGRES_DB: "load" })
    .withExposedPorts(5432)
    .withHealthCheck({
      test: ["CMD-SHELL", "pg_isready -h localhost -U load -d load"],
      interval: 250,
      timeout: 1000,
      retries: 240,
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .start();

  const databaseUrl = `postgresql://load:${password}@127.0.0.1:${container.getMappedPort(5432)}/load`;
  const procs = new Processes(outDir);
  const prisma = createPrismaClient(databaseUrl);
  try {
    runMigrations(databaseUrl);
    const env = {
      DATABASE_URL: databaseUrl,
      MURPHY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      MURPHY_MODE: "local",
    };
    const seeded = spawnSync(process.execPath, ["--import", "tsx", "src/seed.ts", "load"], {
      cwd: path.join(REPO_ROOT, "apps/api"),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    });
    const apiKey = /(mk_\S+)/.exec(seeded.stdout)?.[1];
    if (!apiKey) throw new Error(`seeding failed: ${seeded.stderr}`);

    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const api = procs.start({
      name: "api",
      cwd: "apps/api",
      script: "src/server.ts",
      env: { ...env, PORT: String(port) },
    });
    const deadline = Date.now() + 60_000;
    for (;;) {
      const healthy = await fetch(`${url}/healthz`).then(
        (r) => r.ok,
        () => false,
      );
      if (healthy) break;
      if (Date.now() > deadline) throw new Error("the API did not start");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
    // One endpoint, so each event also writes one delivery row. No worker runs, so it is not sent.
    const created = await fetch(`${url}/v1/endpoints`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: "http://127.0.0.1:9/never-called" }),
    });
    if (!created.ok) throw new Error(`creating an endpoint failed: HTTP ${created.status}`);

    console.log(`[load] ${seconds} s with ${connections} connections against ${url}`);
    let next = 0;
    const result = await autocannon({
      url: `${url}/v1/events`,
      connections,
      duration: seconds,
      method: "POST",
      headers,
      body: JSON.stringify({ type: "payment.captured", payload: { id: "pay_1", amount: 49900 } }),
      requests: [
        {
          setupRequest: (request) => ({
            ...request,
            headers: { ...request.headers, "idempotency-key": `load-${next++}` },
          }),
        },
      ],
    });

    const eventsStored = await prisma.event.count();
    await procs.stop(api);

    const summary = {
      note: "Local baseline with one API process, no workers and a Postgres in Docker. Not a benchmark.",
      seconds,
      connections,
      requestsPerSecond: { average: result.requests.average, p50: result.requests.p50 },
      latencyMs: {
        p50: result.latency.p50,
        p97_5: result.latency.p97_5,
        p99: result.latency.p99,
        max: result.latency.max,
      },
      responses2xx: result["2xx"],
      responsesNon2xx: result.non2xx,
      connectionErrors: result.errors,
      timeouts: result.timeouts,
      eventsStored,
    };
    writeFileSync(path.join(outDir, "load.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    console.log(`[load] saved in ${path.join(outDir, "load.json")}`);
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
