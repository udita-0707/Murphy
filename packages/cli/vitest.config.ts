import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The end-to-end test starts Postgres and real processes.
    hookTimeout: 240_000,
    testTimeout: 120_000,
  },
});
