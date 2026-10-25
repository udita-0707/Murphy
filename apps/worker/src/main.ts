import { createDeliveryQueue, createPrismaClient } from "@murphy/db";
import { loadEnvFile, loadWorkerConfig } from "./config.js";
import { Worker } from "./worker.js";

loadEnvFile();
const config = loadWorkerConfig();
const prisma = createPrismaClient(config.databaseUrl);
const queue = createDeliveryQueue(prisma);

// Delivery execution arrives in a later step; until then claimed rows are released untouched.
const worker = new Worker({
  ...config,
  queue,
  handler: async (delivery) => {
    await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    await queue.releaseLeases(config.workerId, [delivery.id]);
  },
});

worker.start();
console.log(JSON.stringify({ level: "info", msg: "worker started", worker_id: config.workerId }));

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: "info", msg: "shutting down", signal }));
  const released = await worker.stop(config.shutdownTimeoutMs);
  console.log(JSON.stringify({ level: "info", msg: "stopped", released_leases: released }));
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
