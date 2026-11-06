import { DEMO_HANDLERS, prepareDemoTarget, startRun, type DemoHandlerName } from "@murphy/client";
import { badRequest, clientFor, failure, isSeed, isUuid, unauthorized } from "@/lib/server-api";
import { targetOptions } from "@/lib/server-config";

export const dynamic = "force-dynamic";

/** Starts one scenario on one demo handler. */
export async function POST(request: Request) {
  const api = clientFor(request);
  if (!api) return unauthorized();
  const body = (await request.json().catch(() => null)) as {
    scenario_id?: unknown;
    handler?: unknown;
    seed?: unknown;
  } | null;
  if (!isUuid(body?.scenario_id)) return badRequest("scenario_id must be a scenario's id");
  if (!DEMO_HANDLERS.includes(body.handler as DemoHandlerName)) {
    return badRequest("handler must be naive or idempotent");
  }
  if (!isSeed(body.seed)) return badRequest("seed must be a non-negative whole number");
  const handler = body.handler as DemoHandlerName;
  try {
    const endpoint = await prepareDemoTarget(api, targetOptions(), handler);
    const started = await startRun(api, {
      scenarioId: body.scenario_id,
      endpointId: endpoint.endpointId,
      stateUrl: endpoint.stateUrl,
      label: handler,
      seed: body.seed,
    });
    return Response.json(started, { status: 202 });
  } catch (err) {
    return failure(err);
  }
}
