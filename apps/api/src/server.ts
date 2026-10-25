import { createPrismaClient, createRepository } from "@murphy/db";
import { createApp } from "./app.js";
import { loadConfig, loadEnvFile } from "./config.js";

loadEnvFile();
const config = loadConfig();
const prisma = createPrismaClient(config.databaseUrl);
const app = createApp({ repo: createRepository(prisma), encryptionKey: config.encryptionKey });

const server = app.listen(config.port, () => {
  console.log(`Murphy API listening on http://localhost:${config.port}`);
});

function shutdown(): void {
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
