import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// A prisma.config.ts disables Prisma's own .env loading, so load the repo-root .env here.
// Variables already set in the environment win.
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../.env"), quiet: true });

export default defineConfig({
  schema: path.join(here, "prisma/schema.prisma"),
  migrations: { path: path.join(here, "prisma/migrations") },
});
