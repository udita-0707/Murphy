import { createPrismaClient, createRepository } from "@murphy/db";
import { loadBuiltinScenarios } from "@murphy/simulator";
import { createApp } from "./app.js";
import { loadConfig, loadEnvFile } from "./config.js";

loadEnvFile();
const config = loadConfig();
const prisma = createPrismaClient(config.databaseUrl);
const repo = createRepository(prisma);
// A failure here should not stop the API: only the built-in library would be out of date.
void repo.scenarios
  .syncBuiltins(loadBuiltinScenarios())
  .catch((err: unknown) => console.error(`could not install built-in scenarios: ${String(err)}`));
const app = createApp({
  repo,
  encryptionKey: config.encryptionKey,
  mode: config.mode,
});

const server = app.listen(config.port, () => {
  console.log(`Murphy API listening on http://localhost:${config.port} (${config.mode} mode)`);
});

function shutdown(): void {
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
