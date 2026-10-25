import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { randomBytes } from "node:crypto";
import {
  createPrismaClient,
  createRepository,
  runMigrations,
  type PrismaClient,
  type Repository,
} from "@murphy/db";
import type { Express } from "express";
import { generateApiKey } from "../src/api-keys.js";
import { createApp } from "../src/app.js";

export interface TestEnv {
  container: StartedPostgreSqlContainer;
  prisma: PrismaClient;
  repo: Repository;
  app: Express;
  encryptionKey: Buffer;
  stop: () => Promise<void>;
}

/** Starts a real Postgres 16, applies the migrations and builds the app against it. */
export async function startTestEnv(): Promise<TestEnv> {
  // Hosted mode, the production default.
  const container = await new PostgreSqlContainer("postgres:16").start();
  const url = container.getConnectionUri();
  runMigrations(url);
  const prisma = createPrismaClient(url);
  const repo = createRepository(prisma);
  const encryptionKey = randomBytes(32);
  const app = createApp({ repo, encryptionKey, logError: (err) => console.error(err) });
  return {
    container,
    prisma,
    repo,
    app,
    encryptionKey,
    stop: async () => {
      await prisma.$disconnect();
      await container.stop();
    },
  };
}

export interface TestProject {
  id: string;
  apiKey: string;
  auth: { authorization: string };
}

export async function createProject(repo: Repository, name = "test"): Promise<TestProject> {
  const project = await repo.projects.create({ name });
  const key = generateApiKey();
  await repo.apiKeys.create(project.id, { keyPrefix: key.prefix, keyHash: key.hash });
  return { id: project.id, apiKey: key.key, auth: { authorization: `Bearer ${key.key}` } };
}
