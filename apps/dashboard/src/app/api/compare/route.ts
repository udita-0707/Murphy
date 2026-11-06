import { startPair } from "@murphy/client";
import { badRequest, clientFor, failure, isSeed, isUuid, unauthorized } from "@/lib/server-api";
import { targetOptions } from "@/lib/server-config";

export const dynamic = "force-dynamic";

/** Starts one scenario on both demo handlers, with the same seed (ADR 013). */
export async function POST(request: Request) {
  const api = clientFor(request);
  if (!api) return unauthorized();
  const body = (await request.json().catch(() => null)) as {
    scenario_id?: unknown;
    seed?: unknown;
  } | null;
  if (!isUuid(body?.scenario_id)) return badRequest("scenario_id must be a scenario's id");
  if (!isSeed(body.seed)) return badRequest("seed must be a non-negative whole number");
  try {
    return Response.json(
      await startPair(api, targetOptions(), { scenarioId: body.scenario_id, seed: body.seed }),
      { status: 202 },
    );
  } catch (err) {
    return failure(err);
  }
}
