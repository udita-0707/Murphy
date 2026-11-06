import { MurphyClientError, startRun, type MurphyApiClient, type StartedRun } from "./api.js";

/** Run endpoints use this filter, so a project's ordinary events never reach them (ADR 011). */
export const SIMULATION_FILTER = "__murphy_simulation__";

export const DEMO_HANDLERS = ["naive", "idempotent"] as const;
export type DemoHandlerName = (typeof DEMO_HANDLERS)[number];

export interface DemoTargetOptions {
  targetUrl: string;
  /** Sent to `POST /_secrets` on a hosted demo target. Server side only. */
  adminToken?: string;
}

export interface PreparedEndpoint {
  endpointId: string;
  stateUrl: string;
}

/** Creates a throwaway endpoint on the demo target, and gives the target its secret. */
export async function prepareDemoTarget(
  api: MurphyApiClient,
  options: DemoTargetOptions,
  handler: string,
): Promise<PreparedEndpoint> {
  const targetUrl = options.targetUrl.replace(/\/$/, "");
  const url = `${targetUrl}/${handler}`;
  const endpoint = await api.request<{ id: string; secret: string }>("POST", "/v1/endpoints", {
    url,
    description: `murphy run: ${handler}`,
    event_filter: [SIMULATION_FILTER],
  });
  let added: Response;
  try {
    added = await fetch(`${targetUrl}/_secrets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.adminToken ? { authorization: `Bearer ${options.adminToken}` } : {}),
      },
      body: JSON.stringify({ secret: endpoint.secret }),
    });
  } catch {
    await api.request("DELETE", `/v1/endpoints/${endpoint.id}`);
    throw new MurphyClientError(
      `cannot reach the demo target at ${targetUrl}`,
      "target_unreachable",
    );
  }
  if (!added.ok) {
    await api.request("DELETE", `/v1/endpoints/${endpoint.id}`);
    throw new MurphyClientError(
      `the demo target refused the secret: HTTP ${added.status}`,
      "target_refused",
      added.status,
    );
  }
  return { endpointId: endpoint.id, stateUrl: `${url}/state` };
}

export interface StartedSide {
  handler: DemoHandlerName;
  outcome: "started";
  runId: string;
  seed: number;
  endpointId: string;
}

export interface FailedSide {
  handler: DemoHandlerName;
  outcome: "did_not_start";
  reason: string;
}

export type PairSide = StartedSide | FailedSide;

function reasonOf(err: unknown): string {
  if (err instanceof MurphyClientError) return err.message;
  throw err;
}

/**
 * Starts one scenario on both demo handlers with the same seed. Endpoints come first because they are
 * the slow part, so the two run requests leave as close together as possible (ADR 013).
 *
 * There is no cancel: if only one run starts it is left to finish, and the caller shows no comparison.
 */
export async function startPair(
  api: MurphyApiClient,
  options: DemoTargetOptions,
  input: { scenarioId: string; seed?: number },
): Promise<{ naive: PairSide; idempotent: PairSide }> {
  const prepared = await Promise.allSettled(
    DEMO_HANDLERS.map((handler) => prepareDemoTarget(api, options, handler)),
  );
  const started = await Promise.allSettled<StartedRun>(
    DEMO_HANDLERS.map((handler, i) => {
      const endpoint = prepared[i]!;
      if (endpoint.status === "rejected") return Promise.reject(endpoint.reason);
      return startRun(api, {
        scenarioId: input.scenarioId,
        endpointId: endpoint.value.endpointId,
        stateUrl: endpoint.value.stateUrl,
        label: handler,
        seed: input.seed,
      });
    }),
  );
  const side = async (handler: DemoHandlerName, i: number): Promise<PairSide> => {
    const endpoint = prepared[i]!;
    const run = started[i]!;
    if (run.status === "fulfilled" && endpoint.status === "fulfilled") {
      return {
        handler,
        outcome: "started",
        runId: run.value.id,
        seed: run.value.seed,
        endpointId: endpoint.value.endpointId,
      };
    }
    if (run.status === "fulfilled") throw new Error("a run started without its endpoint");
    // The endpoint was never used, so it is safe to delete. Failing to is not worth reporting.
    if (endpoint.status === "fulfilled") {
      await api.request("DELETE", `/v1/endpoints/${endpoint.value.endpointId}`).catch(() => null);
    }
    return { handler, outcome: "did_not_start", reason: reasonOf(run.reason) };
  };
  const [naive, idempotent] = await Promise.all(DEMO_HANDLERS.map(side));
  return { naive: naive!, idempotent: idempotent! };
}
