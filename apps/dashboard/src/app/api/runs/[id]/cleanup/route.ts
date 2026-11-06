import { cleanupDemoEndpoint } from "@murphy/client";
import { clientFor, failure, isUuid } from "@/lib/server-api";

export const dynamic = "force-dynamic";

/** Removes a finished run's throwaway endpoint, the same way the CLI does. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const client = clientFor(request);
  if ("response" in client) return client.response;
  const { api } = client;
  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ outcome: "kept" });
  try {
    return Response.json({ outcome: await cleanupDemoEndpoint(api, id) });
  } catch (err) {
    return failure(err);
  }
}
