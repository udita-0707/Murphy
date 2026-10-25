import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEncryptionKey } from "@murphy/core";
import { config as loadDotenv } from "dotenv";

export interface Config {
  databaseUrl: string;
  encryptionKey: Buffer;
  port: number;
}

/** Loads the repo-root .env (if present) without overriding variables already set. */
export function loadEnvFile(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  loadDotenv({ path: path.join(root, ".env"), quiet: true });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (see .env.example)");
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a valid port number, got ${env.PORT}`);
  }
  return {
    databaseUrl: env.DATABASE_URL,
    encryptionKey: parseEncryptionKey(env.MURPHY_ENCRYPTION_KEY),
    port,
  };
}
