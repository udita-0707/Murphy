import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Applies all Prisma migrations to the given database (used by integration tests). */
export function runMigrations(databaseUrl: string): void {
  const result = spawnSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${result.stdout}\n${result.stderr}`);
  }
}
