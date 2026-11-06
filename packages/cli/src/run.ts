import { readFile } from "node:fs/promises";
import path from "node:path";

/** Run endpoints use this filter, so a project's ordinary events never reach them (ADR 011). */
export const SIMULATION_FILTER = "__murphy_simulation__";
const POLL_MS = 500;
/** Longer than any library scenario. A run past this is reported, not waited on forever. */
const WATCH_LIMIT_MS = 5 * 60_000;

export const EXIT = { passed: 0, failed: 1, errored: 2, usage: 3 } as const;

export interface RunArgs {
  file: string;
  /** Run against the demo target's handler. */
  target?: "naive" | "idempotent";
  /** Or against your own endpoint, with its state URL. */
  endpoint?: string;
  stateUrl?: string;
  label?: string;
  seed?: number;
  reportPath?: string;
}

export class UsageError extends Error {}

export const USAGE = `Usage:
  murphy run <scenario.yaml> --target naive|idempotent [--seed N] [--report out.md]
  murphy run <scenario.yaml> --endpoint <id> --state-url <url> [--label name] [--seed N] [--report out.md]

Environment:
  MURPHY_API_KEY     your project's API key (required)
  MURPHY_API_URL     default http://127.0.0.1:3000
  MURPHY_TARGET_URL  the demo target, default http://127.0.0.1:4343

Exit codes: 0 passed, 1 failed, 2 errored (the run proves nothing), 3 usage or setup problem.`;

export function parseArgs(argv: readonly string[]): RunArgs {
  const [command, file, ...rest] = argv;
  if (command !== "run" || !file || file.startsWith("--")) throw new UsageError(USAGE);
  const args: RunArgs = { file };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    const value = rest[i + 1];
    if (value === undefined) throw new UsageError(`${flag} needs a value\n\n${USAGE}`);
    switch (flag) {
      case "--target":
        if (value !== "naive" && value !== "idempotent") {
          throw new UsageError(`--target must be naive or idempotent, not "${value}"`);
        }
        args.target = value;
        break;
      case "--endpoint":
        args.endpoint = value;
        break;
      case "--state-url":
        args.stateUrl = value;
        break;
      case "--label":
        args.label = value;
        break;
      case "--report":
        args.reportPath = value;
        break;
      case "--seed": {
        const seed = Number(value);
        if (!Number.isInteger(seed) || seed < 0) {
          throw new UsageError(`--seed must be a non-negative whole number, not "${value}"`);
        }
        args.seed = seed;
        break;
      }
      default:
        throw new UsageError(`unknown option ${flag}\n\n${USAGE}`);
    }
  }
  const own = args.endpoint !== undefined || args.stateUrl !== undefined;
  if (args.target && own) {
    throw new UsageError("use --target, or --endpoint with --state-url, not both");
  }
  if (!args.target && !(args.endpoint && args.stateUrl)) {
    throw new UsageError(`say what to test: --target, or --endpoint with --state-url\n\n${USAGE}`);
  }
  return args;
}

export interface Env {
  apiKey: string;
  apiUrl: string;
  targetUrl: string;
}

export function readEnv(env: NodeJS.ProcessEnv): Env {
  if (!env.MURPHY_API_KEY) {
    throw new UsageError("MURPHY_API_KEY is not set. `pnpm db:seed` prints a key.");
  }
  return {
    apiKey: env.MURPHY_API_KEY,
    apiUrl: (env.MURPHY_API_URL ?? "http://127.0.0.1:3000").replace(/\/$/, ""),
    targetUrl: (env.MURPHY_TARGET_URL ?? "http://127.0.0.1:4343").replace(/\/$/, ""),
  };
}

interface LiveAttempt {
  attempt_no: number;
  at_ms: number | null;
  status: number | null;
  error: string | null;
}

export interface LiveRun {
  status: string;
  seed: number;
  scenario: { slug: string; name: string };
  steps: { id: string; event_type: string; fault_kinds: string[] }[];
  deliveries: { delivery_id: string; step: string; attempts: LiveAttempt[] }[];
  report_ready: boolean;
}

export interface ReportSummary {
  run: { status: "passed" | "failed" | "errored"; reason: string | null; duration_ms: number };
  scenario: { name: string };
  assertions: { kind: string; entity: string; status: string; reason: string }[];
  faults: { step: string; kind: string; realised_by: string; realised: boolean }[];
}

/** Which faults to show on one line: a retry or the first copy of a duplicate is not itself the fault. */
function faultsOnLine(run: LiveRun, kinds: string[], step: string, id: string, attempt: number) {
  const copies = run.deliveries
    .filter((d) => d.step === step)
    .sort((x, y) => (x.attempts[0]?.at_ms ?? Infinity) - (y.attempts[0]?.at_ms ?? Infinity));
  const isLaterCopy = copies[0]?.delivery_id !== id;
  return kinds.filter((kind) =>
    kind === "duplicate" ? isLaterCopy : attempt === 1 && !isLaterCopy,
  );
}

/** One timeline line per attempt that has not been shown yet, oldest first. */
export function newTimelineLines(run: LiveRun, shown: Set<string>): string[] {
  const steps = new Map(run.steps.map((s) => [s.id, s]));
  const fresh = run.deliveries
    .flatMap((d) => d.attempts.map((attempt) => ({ d, attempt })))
    .filter(({ d, attempt }) => !shown.has(`${d.delivery_id}:${attempt.attempt_no}`))
    .sort((a, b) => (a.attempt.at_ms ?? 0) - (b.attempt.at_ms ?? 0));
  return fresh.map(({ d, attempt }) => {
    shown.add(`${d.delivery_id}:${attempt.attempt_no}`);
    const step = steps.get(d.step);
    const at = `+${((attempt.at_ms ?? 0) / 1000).toFixed(2)}s`.padStart(8);
    const result = attempt.status === null ? (attempt.error ?? "no response") : attempt.status;
    const kinds = faultsOnLine(
      run,
      step?.fault_kinds ?? [],
      d.step,
      d.delivery_id,
      attempt.attempt_no,
    );
    const faults = kinds.length ? `  [${kinds.join(", ")}]` : "";
    const retry = attempt.attempt_no > 1 ? ` (attempt ${attempt.attempt_no})` : "";
    return `${at}  ${(step?.event_type ?? d.step).padEnd(24)} ${String(result).padEnd(5)}${retry}${faults}`.trimEnd();
  });
}

export function summaryLines(report: ReportSummary): string[] {
  const label = { passed: "PASS", failed: "FAIL", errored: "ERROR" }[report.run.status];
  const lines = [
    `${label}  ${report.scenario.name}  (${(report.run.duration_ms / 1000).toFixed(1)} s)`,
  ];
  if (report.run.status === "errored" && report.run.reason) lines.push(`  ${report.run.reason}`);
  lines.push("");
  for (const a of report.assertions) {
    const status = a.status === "not_evaluated" ? "----" : a.status.toUpperCase();
    lines.push(`  ${status}  ${a.kind} (${a.entity}): ${a.reason}`);
  }
  if (report.faults.length > 0) {
    lines.push("", "  Faults:");
    for (const f of report.faults) {
      const by = f.realised_by === "engine" ? "real engine" : "target cooperated";
      lines.push(
        `    ${f.kind} on ${f.step}: ${f.realised ? "happened" : "DID NOT HAPPEN"} (${by})`,
      );
    }
  }
  return lines;
}

class ApiClient {
  constructor(private readonly env: Env) {}

  async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.env.apiUrl}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${this.env.apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new UsageError(
        `cannot reach the Murphy API at ${this.env.apiUrl}. Is \`pnpm dev\` running?`,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error: { message: string } }).error.message;
      } catch {
        // Not our error format, so show it as it is.
      }
      throw new UsageError(`${method} ${route} answered ${res.status}: ${message}`);
    }
    if (res.headers.get("content-type")?.includes("json")) return JSON.parse(text) as T;
    return text as T;
  }
}

/** Creates a throwaway endpoint on the demo target, and gives the target its secret. */
async function prepareDemoTarget(api: ApiClient, env: Env, handler: string) {
  const url = `${env.targetUrl}/${handler}`;
  const endpoint = await api.request<{ id: string; secret: string }>("POST", "/v1/endpoints", {
    url,
    description: `murphy run: ${handler}`,
    event_filter: [SIMULATION_FILTER],
  });
  let added: Response;
  try {
    added = await fetch(`${env.targetUrl}/_secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: endpoint.secret }),
    });
  } catch {
    await api.request("DELETE", `/v1/endpoints/${endpoint.id}`);
    throw new UsageError(
      `cannot reach the demo target at ${env.targetUrl}. Is \`pnpm demo:target\` running?`,
    );
  }
  if (!added.ok) {
    await api.request("DELETE", `/v1/endpoints/${endpoint.id}`);
    throw new UsageError(`the demo target refused the secret: HTTP ${added.status}`);
  }
  return { endpointId: endpoint.id, stateUrl: `${url}/state` };
}

/** Runs a scenario and prints its timeline as it happens. Returns the process's exit code. */
export async function runCommand(
  args: RunArgs,
  env: Env,
  print: (line: string) => void,
  cwd: string,
): Promise<number> {
  const api = new ApiClient(env);
  const filePath = path.resolve(cwd, args.file);
  let yaml: string;
  try {
    yaml = await readFile(filePath, "utf8");
  } catch {
    throw new UsageError(`cannot read ${filePath}`);
  }

  const scenario = await api.request<{ id: string; slug: string }>("POST", "/v1/scenarios", {
    definition_yaml: yaml,
  });
  const created = args.target ? await prepareDemoTarget(api, env, args.target) : null;
  const endpointId = created?.endpointId ?? args.endpoint!;
  const stateUrl = created?.stateUrl ?? args.stateUrl!;
  const label = args.target ?? args.label ?? null;

  const started = await api.request<{ id: string; seed: number }>("POST", "/v1/runs", {
    scenario_id: scenario.id,
    endpoint_id: endpointId,
    state_url: stateUrl,
    ...(label ? { target_label: label } : {}),
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
  });

  print(`murphy  ${scenario.slug}  against ${label ?? endpointId}  (seed ${started.seed})`);
  print(`run     ${started.id}`);
  print("");
  print("      at  event                    reply");

  const shown = new Set<string>();
  const deadline = Date.now() + WATCH_LIMIT_MS;
  for (;;) {
    const run = await api.request<LiveRun>("GET", `/v1/runs/${started.id}`);
    for (const line of newTimelineLines(run, shown)) print(line);
    if (run.report_ready) break;
    if (Date.now() > deadline) {
      print("");
      print(`Gave up watching. The run may still finish: GET /v1/runs/${started.id}`);
      return EXIT.errored;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  const report = await api.request<ReportSummary>("GET", `/v1/runs/${started.id}/report`);
  print("");
  for (const line of summaryLines(report)) print(line);
  print("");
  if (args.reportPath) {
    const { writeFile } = await import("node:fs/promises");
    const out = path.resolve(cwd, args.reportPath);
    await writeFile(
      out,
      await api.request<string>("GET", `/v1/runs/${started.id}/report?format=md`),
    );
    print(`Report saved to ${out}`);
  } else {
    print(`Full report: --report out.md, or GET /v1/runs/${started.id}/report?format=md`);
  }

  // Only now: the report is stored, so deleting the endpoint cannot touch this run's verdict.
  if (created) await api.request("DELETE", `/v1/endpoints/${created.endpointId}`);
  return EXIT[report.run.status];
}
