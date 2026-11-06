import { describe, expect, it } from "vitest";
import { compile, loadBuiltinScenarios, parseScenario, renderReport } from "../src/index.js";

const library = loadBuiltinScenarios();
const parsed = library.map((s) => parseScenario(s.definitionYaml));

describe("scenario library", () => {
  it("has at least six scenarios, two of them about bookings", () => {
    expect(library.length).toBeGreaterThanOrEqual(6);
    expect(parsed.filter((s) => s.provider === "booking").length).toBeGreaterThanOrEqual(2);
  });

  it("has unique slugs and seeds", () => {
    expect(new Set(parsed.map((s) => s.slug)).size).toBe(parsed.length);
    expect(new Set(parsed.map((s) => s.seed)).size).toBe(parsed.length);
  });

  it.each(parsed.map((s) => [s.slug, s] as const))("%s injects a fault and compiles", (_s, s) => {
    const plan = compile(s, { runId: "run" });
    expect(plan.steps.some((step) => step.faults.length > 0)).toBe(true);
    expect(plan.assertions.length).toBeGreaterThan(0);
    expect(renderReport).toBeTypeOf("function");
  });

  it("marks every provider that appears as a style, not the real thing", () => {
    for (const s of parsed) {
      expect(compile(s, { runId: "run" }).scenario.label).toMatch(/style/i);
    }
  });
});
