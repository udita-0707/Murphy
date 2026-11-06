import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseScenario } from "./scenario.js";

const SCENARIO_DIR = fileURLToPath(new URL("../scenarios/", import.meta.url));

export interface BuiltinScenario {
  slug: string;
  name: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  definitionYaml: string;
}

/** The built-in library, from `packages/simulator/scenarios`. Every file must be valid. */
export function loadBuiltinScenarios(): BuiltinScenario[] {
  return readdirSync(SCENARIO_DIR)
    .filter((file) => file.endsWith(".yaml"))
    .sort()
    .map((file) => {
      const definitionYaml = readFileSync(new URL(file, `file://${SCENARIO_DIR}`), "utf8");
      const scenario = parseScenario(definitionYaml);
      if (`${scenario.slug}.yaml` !== file) {
        throw new Error(`${file} has the slug "${scenario.slug}", which must match its file name`);
      }
      return {
        slug: scenario.slug,
        name: scenario.name,
        difficulty: scenario.difficulty,
        definitionYaml,
      };
    });
}
