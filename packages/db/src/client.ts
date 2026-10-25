import { PrismaClient } from "@prisma/client";

export type { PrismaClient };

/** Creates a Prisma client. Defaults to DATABASE_URL from the environment. */
export function createPrismaClient(databaseUrl?: string): PrismaClient {
  return new PrismaClient(databaseUrl ? { datasourceUrl: databaseUrl } : undefined);
}
