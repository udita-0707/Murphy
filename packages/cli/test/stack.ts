import { createPrismaClient, runMigrations, type PrismaClient } from "@murphy/db";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** The real thing: Postgres in a container, and the API, worker and demo target as processes. */
export interface Stack {
  apiUrl: string;
  targetUrl: string;
  apiKey: string;
  databaseUrl: string;
  encryptionKey: string;
  prisma: PrismaClient;
  stop(): Promise<void>;
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

async function waitFor(url: string, name: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const up = await fetch(url).then(
      (r) => r.ok,
      () => false,
    );
    if (up) return;
    if (Date.now() > deadline) throw new Error(`${name} did not start`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export async function startStack(
  extraEnv: Record<string, string> = {},
  options: { worker?: boolean } = {},
): Promise<Stack> {
  const password = randomBytes(16).toString("hex");
  const container: StartedTestContainer = await new GenericContainer("postgres:16")
    .withEnvironment({ POSTGRES_USER: "sim", POSTGRES_PASSWORD: password, POSTGRES_DB: "sim" })
    .withExposedPorts(5432)
    .withHealthCheck({
      test: ["CMD-SHELL", "pg_isready -h localhost -U sim -d sim"],
      interval: 250,
      timeout: 1000,
      // A full test run starts many containers at once, so give this one room.
      retries: 960,
    })
    .withStartupTimeout(240_000)
    .withWaitStrategy(Wait.forHealthCheck())
    .start();
  const databaseUrl = `postgresql://sim:${password}@127.0.0.1:${container.getMappedPort(5432)}/sim`;
  runMigrations(databaseUrl);
  const prisma = createPrismaClient(databaseUrl);

  // Every variable is explicit, so nothing can reach a developer's database through .env.
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    DATABASE_URL: databaseUrl,
    MURPHY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    MURPHY_MODE: "local",
    ...extraEnv,
  };
  const seeded = spawnSync(process.execPath, ["--import", "tsx", "src/seed.ts", "simulator"], {
    cwd: path.join(REPO_ROOT, "apps/api"),
    encoding: "utf8",
    env,
  });
  const apiKey = /(mk_\S+)/.exec(seeded.stdout)?.[1];
  if (!apiKey) throw new Error(`seeding failed: ${seeded.stderr}`);

  const apiPort = await freePort();
  const targetPort = await freePort();
  const children: ChildProcess[] = [];
  const start = (cwd: string, script: string, extra: Record<string, string> = {}) => {
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: path.join(REPO_ROOT, cwd),
      env: { ...env, ...extra },
      stdio: "ignore",
    });
    children.push(child);
  };
  start("apps/api", "src/server.ts", { PORT: String(apiPort) });
  if (options.worker !== false) start("apps/worker", "src/main.ts");
  start("tools/demo-target", "src/main.ts", { DEMO_TARGET_PORT: String(targetPort) });

  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const targetUrl = `http://127.0.0.1:${targetPort}`;
  await waitFor(`${apiUrl}/healthz`, "the API");
  await waitFor(`${targetUrl}/healthz`, "the demo target");

  return {
    apiUrl,
    targetUrl,
    apiKey,
    databaseUrl,
    encryptionKey: env.MURPHY_ENCRYPTION_KEY,
    prisma,
    stop: async () => {
      for (const child of children) child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      for (const child of children) child.kill("SIGKILL");
      await prisma.$disconnect().catch(() => undefined);
      await container.stop({ timeout: 0 }).catch(() => undefined);
    },
  };
}

export interface CliResult {
  code: number | null;
  output: string;
}

/** Runs `murphy` as a real process. */
export function runCli(stack: Stack, args: string[], env: Record<string, string> = {}) {
  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", ...args], {
      cwd: path.join(REPO_ROOT, "packages/cli"),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        INIT_CWD: REPO_ROOT,
        MURPHY_API_KEY: stack.apiKey,
        MURPHY_API_URL: stack.apiUrl,
        MURPHY_TARGET_URL: stack.targetUrl,
        ...env,
      },
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}
