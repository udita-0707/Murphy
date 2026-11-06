import type { Repository, ScenarioRecord } from "@murphy/db";
import { parseScenario, ScenarioError, type Scenario } from "@murphy/simulator";
import { Router } from "express";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { projectIdOf } from "../middleware/auth.js";
import { parse } from "../validation.js";

const createScenarioBody = z.strictObject({ definition_yaml: z.string().min(1) });

function serializeScenario(scenario: ScenarioRecord) {
  return {
    id: scenario.id,
    slug: scenario.slug,
    name: scenario.name,
    difficulty: scenario.difficulty,
    builtin: scenario.projectId === null,
    definition_yaml: scenario.definitionYaml,
    created_at: scenario.createdAt.toISOString(),
  };
}

/** Parses a scenario, turning its problems into a 422 that lists each one by path. */
export function parseScenarioOrThrow(yaml: string): Scenario {
  try {
    return parseScenario(yaml);
  } catch (err) {
    if (err instanceof ScenarioError) throw new ApiError(422, "invalid_scenario", err.message);
    throw err;
  }
}

export function scenariosRouter(repo: Repository): Router {
  const router = Router();

  /** Creates a scenario, or replaces this project's scenario with the same slug. */
  router.post("/", async (req, res) => {
    const body = parse(createScenarioBody, req.body);
    const scenario = parseScenarioOrThrow(body.definition_yaml);
    const saved = await repo.scenarios.save(projectIdOf(res), {
      slug: scenario.slug,
      name: scenario.name,
      difficulty: scenario.difficulty,
      definitionYaml: body.definition_yaml,
    });
    res.status(201).json(serializeScenario(saved));
  });

  router.get("/", async (_req, res) => {
    const scenarios = await repo.scenarios.list(projectIdOf(res));
    res.json({ data: scenarios.map(serializeScenario) });
  });

  return router;
}
