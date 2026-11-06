import { generateSigningSecret, signHeaders } from "@murphy/core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli, startStack, type Stack } from "./stack.js";

const scenario = (slug: string) => `packages/simulator/scenarios/${slug}.yaml`;

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await stack?.stop();
});

/**
 * The definition of done for phase 4: real API, worker and demo target processes, real Postgres,
 * real retry schedule, and `murphy` as a real process.
 */
describe("murphy run, end to end", () => {
  describe.each(["booking-duplicate-confirmation", "booking-cancel-before-confirm"])(
    "%s",
    (slug) => {
      it("FAILS on the naive handler, with exit code 1", async () => {
        const { code, output } = await runCli(stack, ["run", scenario(slug), "--target", "naive"]);
        expect(output).toMatch(/^FAIL {2}/m);
        expect(code, output).toBe(1);
        expect(output).toMatch(/reservation\.created/);
        expect(output).toMatch(/\(real engine\)/);
      });

      it("PASSES on the idempotent handler, with exit code 0", async () => {
        const { code, output } = await runCli(stack, [
          "run",
          scenario(slug),
          "--target",
          "idempotent",
        ]);
        expect(output).toMatch(/^PASS {2}/m);
        expect(code, output).toBe(0);
      });
    },
  );

  it("saves a readable report, and removes the endpoint only after the report is stored", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "murphy-report-"));
    const out = path.join(dir, "report.md");
    try {
      const { code, output } = await runCli(stack, [
        "run",
        scenario("booking-cancel-before-confirm"),
        "--target",
        "naive",
        "--report",
        out,
      ]);
      expect(code, output).toBe(1);
      const text = readFileSync(out, "utf8");
      expect(text).toMatch(/^# FAILED: Cancel event arrives before the confirmation/);
      expect(text).toMatch(/\| Handler \| naive \|/);
      expect(text).toMatch(/\| cancelled \| reorder \| Engine \|/);
      expect(text).toMatch(/Ended in "confirmed", expected "cancelled"/);
      expect(text).toMatch(/## What this does not prove/);

      const runId = /^run\s+(\S+)/m.exec(output)![1]!;
      const run = await stack.prisma.scenarioRun.findUniqueOrThrow({
        where: { id: runId },
        include: { endpoint: true },
      });
      expect(run.report).not.toBeNull();
      expect(run.endpoint.deletedAt).not.toBeNull();
      expect(run.finishedAt!.getTime()).toBeLessThanOrEqual(run.endpoint.deletedAt!.getTime());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the same seed sends the same payloads on a new run", async () => {
    const payloads = async () => {
      const { output } = await runCli(stack, [
        "run",
        scenario("booking-duplicate-confirmation"),
        "--target",
        "idempotent",
        "--seed",
        "99",
      ]);
      const runId = /^run\s+(\S+)/m.exec(output)![1]!;
      const events = await stack.prisma.event.findMany({
        where: { scenarioRunId: runId },
        orderBy: { type: "asc" },
      });
      return events.map((e) => {
        const { _murphy, ...provider } = e.payload as Record<string, unknown>;
        expect((_murphy as { simulated: boolean }).simulated).toBe(true);
        return provider;
      });
    };
    expect(await payloads()).toEqual(await payloads());
  });

  it("explains a missing scenario file, with exit code 3", async () => {
    const { code, output } = await runCli(stack, [
      "run",
      "packages/cli/test/does-not-exist.yaml",
      "--target",
      "naive",
    ]);
    expect(code).toBe(3);
    expect(output).toMatch(/cannot read/);
  });

  it("explains a demo target that is not running, and leaves no endpoint behind", async () => {
    const before = await stack.prisma.endpoint.count({ where: { deletedAt: null } });
    const { code, output } = await runCli(
      stack,
      ["run", scenario("booking-duplicate-confirmation"), "--target", "naive"],
      { MURPHY_TARGET_URL: "http://127.0.0.1:9" },
    );
    expect(code).toBe(3);
    expect(output).toMatch(/pnpm demo:target/);
    expect(await stack.prisma.endpoint.count({ where: { deletedAt: null } })).toBe(before);
  });

  it("explains a wrong API key, with exit code 3", async () => {
    const { code, output } = await runCli(
      stack,
      ["run", scenario("booking-duplicate-confirmation"), "--target", "naive"],
      { MURPHY_API_KEY: "mk_wrong" },
    );
    expect(code).toBe(3);
    expect(output).toMatch(/401/);
    expect(output).not.toMatch(/mk_wrong/);
  });

  it("the demo target itself refuses an unsigned webhook", async () => {
    const res = await fetch(`${stack.targetUrl}/naive`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    const signed = signHeaders({
      id: "msg_1",
      timestamp: Math.floor(Date.now() / 1000),
      body: "{}",
      secrets: [generateSigningSecret()],
    });
    const wrong = await fetch(`${stack.targetUrl}/naive`, {
      method: "POST",
      headers: signed,
      body: "{}",
    });
    expect(wrong.status).toBe(401);
  });
});
