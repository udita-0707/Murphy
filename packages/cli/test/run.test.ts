import { describe, expect, it } from "vitest";
import {
  newTimelineLines,
  parseArgs,
  readEnv,
  summaryLines,
  UsageError,
  type LiveRun,
  type ReportSummary,
} from "../src/run.js";

describe("parseArgs", () => {
  it("reads a demo target run", () => {
    expect(parseArgs(["run", "a.yaml", "--target", "naive", "--seed", "7"])).toEqual({
      file: "a.yaml",
      target: "naive",
      seed: 7,
    });
  });

  it("reads a run against your own endpoint", () => {
    expect(
      parseArgs([
        "run",
        "a.yaml",
        "--endpoint",
        "e1",
        "--state-url",
        "http://x/s",
        "--label",
        "me",
      ]),
    ).toEqual({ file: "a.yaml", endpoint: "e1", stateUrl: "http://x/s", label: "me" });
  });

  it.each([
    [[], /Usage/],
    [["replay", "a"], /Usage/],
    [["run"], /Usage/],
    [["run", "--target", "naive"], /Usage/],
    [["run", "a.yaml"], /say what to test/],
    [["run", "a.yaml", "--target", "clever"], /naive or idempotent/],
    [["run", "a.yaml", "--target"], /needs a value/],
    [["run", "a.yaml", "--target", "naive", "--seed", "x"], /whole number/],
    [["run", "a.yaml", "--target", "naive", "--seed", "-1"], /whole number/],
    [["run", "a.yaml", "--target", "naive", "--nope", "1"], /unknown option/],
    [["run", "a.yaml", "--endpoint", "e1"], /say what to test/],
    [["run", "a.yaml", "--target", "naive", "--endpoint", "e1"], /not both/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseArgs(argv as string[])).toThrow(UsageError);
    expect(() => parseArgs(argv as string[])).toThrow(message as RegExp);
  });
});

describe("readEnv", () => {
  it("needs a key, and has local defaults", () => {
    expect(() => readEnv({})).toThrow(/MURPHY_API_KEY/);
    expect(readEnv({ MURPHY_API_KEY: "k" })).toEqual({
      apiKey: "k",
      apiUrl: "http://127.0.0.1:3000",
      targetUrl: "http://127.0.0.1:4343",
    });
    expect(readEnv({ MURPHY_API_KEY: "k", MURPHY_API_URL: "http://a/" }).apiUrl).toBe("http://a");
  });
});

describe("newTimelineLines", () => {
  const run = (attempts: LiveRun["deliveries"]): LiveRun => ({
    status: "running",
    seed: 1,
    scenario: { slug: "s", name: "S" },
    report_ready: false,
    steps: [
      { id: "created", event_type: "reservation.created", fault_kinds: [] },
      { id: "confirmed", event_type: "reservation.confirmed", fault_kinds: ["duplicate"] },
    ],
    deliveries: attempts,
  });
  const attempt = (n: number, at: number, status: number | null, error: string | null = null) => ({
    attempt_no: n,
    at_ms: at,
    status,
    error,
  });

  it("prints each attempt once, in the order it happened", () => {
    const shown = new Set<string>();
    const first = run([
      { delivery_id: "b", step: "confirmed", attempts: [attempt(1, 2_500, 200)] },
      { delivery_id: "a", step: "created", attempts: [attempt(1, 1_000, 200)] },
    ]);
    const lines = newTimelineLines(first, shown);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/\+1\.00s\s+reservation\.created\s+200/);
    expect(lines[1]).toMatch(/\+2\.50s\s+reservation\.confirmed\s+200/);
    expect(newTimelineLines(first, shown)).toEqual([]);
  });

  it("tags only the later copy as the duplicate, and only the first attempt with other faults", () => {
    const lines = newTimelineLines(
      run([
        { delivery_id: "z", step: "confirmed", attempts: [attempt(1, 3_000, 200)] },
        { delivery_id: "y", step: "confirmed", attempts: [attempt(1, 2_000, 200)] },
      ]),
      new Set(),
    );
    expect(lines[0]).not.toMatch(/duplicate/);
    expect(lines[1]).toMatch(/\[duplicate\]/);

    const dropped = run([
      {
        delivery_id: "a",
        step: "confirmed",
        attempts: [attempt(1, 1, 503), attempt(2, 2, 200)],
      },
    ]);
    dropped.steps[1]!.fault_kinds = ["drop_then_redeliver"];
    const retried = newTimelineLines(dropped, new Set());
    expect(retried[0]).toMatch(/\[drop_then_redeliver\]/);
    expect(retried[1]).not.toMatch(/drop_then_redeliver/);
    expect(retried[1]).toMatch(/\(attempt 2\)/);
  });

  it("marks retries, and shows an error when there is no status", () => {
    const lines = newTimelineLines(
      run([
        {
          delivery_id: "a",
          step: "created",
          attempts: [attempt(1, 1, null, "timeout: too slow"), attempt(2, 2, 200)],
        },
      ]),
      new Set(),
    );
    expect(lines[0]).toMatch(/timeout: too slow/);
    expect(lines[1]).toMatch(/\(attempt 2\)/);
  });
});

describe("summaryLines", () => {
  const report = (status: ReportSummary["run"]["status"]): ReportSummary => ({
    run: { status, reason: "the reason", duration_ms: 1_500 },
    scenario: { name: "Name" },
    assertions: [
      { kind: "final_state", entity: "stay", status: "fail", reason: "Ended wrong" },
      { kind: "no_double_booking", entity: "stay", status: "pass", reason: "Fine" },
      { kind: "exactly_once_effect", entity: "stay", status: "not_evaluated", reason: "No state" },
    ],
    faults: [
      { step: "a", kind: "duplicate", realised_by: "engine", realised: true },
      { step: "b", kind: "respond_with", realised_by: "target", realised: false },
    ],
  });

  it("leads with the verdict", () => {
    expect(summaryLines(report("passed"))[0]).toBe("PASS  Name  (1.5 s)");
    expect(summaryLines(report("failed"))[0]).toMatch(/^FAIL/);
    expect(summaryLines(report("errored"))[0]).toMatch(/^ERROR/);
  });

  it("gives the reason for an errored run", () => {
    expect(summaryLines(report("errored"))).toContain("  the reason");
  });

  it("gives each assertion, and says who realised each fault", () => {
    const text = summaryLines(report("failed")).join("\n");
    expect(text).toMatch(/FAIL {2}final_state \(stay\): Ended wrong/);
    expect(text).toMatch(/PASS {2}no_double_booking/);
    expect(text).toMatch(/---- {2}exactly_once_effect/);
    expect(text).toMatch(/duplicate on a: happened \(real engine\)/);
    expect(text).toMatch(/respond_with on b: DID NOT HAPPEN \(target cooperated\)/);
  });
});
