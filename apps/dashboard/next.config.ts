import { config as loadDotenv } from "dotenv";
import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// The repo-root .env, as for the API and the worker. Never overrides what is already set.
loadDotenv({ path: path.join(root, ".env"), quiet: true });

const config: NextConfig = {
  // The end-to-end test builds apart, so it cannot disturb a running dev server.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Lint runs from the repo root.
  eslint: { ignoreDuringBuilds: true },
  outputFileTracingRoot: root,
  // Workspace packages ship TypeScript source, imported with Node-style ".js" paths.
  transpilePackages: ["@murphy/client", "@murphy/core"],
  webpack: (webpack) => {
    webpack.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return webpack;
  },
  poweredByHeader: false,
};

export default config;
