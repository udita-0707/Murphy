import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Integration tests start a Postgres container; the first run may pull the image.
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
