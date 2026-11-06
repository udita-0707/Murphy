import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const config: NextConfig = {
  // The end-to-end test builds apart, so it cannot disturb a running dev server.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Lint runs from the repo root.
  eslint: { ignoreDuringBuilds: true },
  outputFileTracingRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  // Workspace packages ship TypeScript source, imported with Node-style ".js" paths.
  transpilePackages: ["@murphy/client"],
  webpack: (webpack) => {
    webpack.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return webpack;
  },
  poweredByHeader: false,
};

export default config;
