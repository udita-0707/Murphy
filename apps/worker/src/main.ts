import { createDeliveryQueue, createPrismaClient } from "@murphy/db";
import { loadEnvFile, loadWorkerConfig } from "./config.js";
import { createDeliveryHandler } from "./deliver.js";
import { startReaper } from "./reaper.js";
import { Worker } from "./worker.js";

loadEnvFile();
const config = loadWorkerConfig();
const prisma = createPrismaClient(config.databaseUrl);
const queue = createDeliveryQueue(prisma);

const worker = new Worker({
  ...config,
  queue,
  handler: createDeliveryHandler({
    queue,
    workerId: config.workerId,
    encryptionKey: config.encryptionKey,
    mode: config.mode,
    requestTimeoutMs: config.requestTimeoutMs,
    onAttempt: (info) => console.log(JSON.stringify({ level: "info", msg: "attempt", ...info })),
  }),
});

worker.start();
const stopReaper = startReaper({
  queue,
  intervalMs: config.reapIntervalMs,
  onReap: (reaped) =>
    console.log(JSON.stringify({ level: "warn", msg: "reaped expired leases", reaped })),
  onError: (err) =>
    console.error(JSON.stringify({ level: "error", context: "reaper", err: String(err) })),
});
console.log(
  JSON.stringify({
    level: "info",
    msg: "worker started",
    worker_id: config.workerId,
    mode: config.mode,
  }),
);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", msg: "shutting down", signal }));
  await stopReaper();
  const released = await worker.stop(config.shutdownTimeoutMs);
  console.log(JSON.stringify({ level: "info", msg: "stopped", released_leases: released }));
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
