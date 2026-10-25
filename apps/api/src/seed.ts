import { createPrismaClient, createRepository } from "@murphy/db";
import { generateApiKey } from "./api-keys.js";
import { loadEnvFile } from "./config.js";

/** Creates a project and an API key, and prints the key once. It is stored only as a hash. */
loadEnvFile();
const name = process.argv[2] ?? "Murphy demo";
const prisma = createPrismaClient();
try {
  const repo = createRepository(prisma);
  const project = await repo.projects.create({ name });
  const apiKey = generateApiKey();
  await repo.apiKeys.create(project.id, { keyPrefix: apiKey.prefix, keyHash: apiKey.hash });
  console.log(`Created project "${project.name}" (${project.id})`);
  console.log(`API key (shown once, store it now): ${apiKey.key}`);
} finally {
  await prisma.$disconnect();
}
