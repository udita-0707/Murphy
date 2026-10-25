import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { resetDemo } from "./reset.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// Variables already set in the environment win over .env.
loadDotenv({ path: path.join(root, ".env"), quiet: true });

const status = resetDemo(
  process.env,
  (step) => spawnSync(step.command, step.args, { cwd: root, stdio: "inherit" }).status ?? 1,
  (line) => console.log(line),
);
process.exit(status);
