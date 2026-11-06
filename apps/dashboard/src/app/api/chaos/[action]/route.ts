import { MurphyApiClient, MurphyClientError } from "@murphy/client";
import { credentialFor } from "@/lib/auth-server";
import { chaosGuard, controlUrl } from "@/lib/chaos-server";
import { apiUrl } from "@/lib/server-config";

export const dynamic = "force-dynamic";

/** A fixed list: nothing from the request becomes a path on the control service. */
const ACTIONS: Record<string, { method: "GET" | "POST"; path: string }> = {
  status: { method: "GET", path: "/status" },
  "kill-worker": { method: "POST", path: "/actions/kill-worker" },
  "restart-postgres": { method: "POST", path: "/actions/restart-postgres" },
  "target-fail": { method: "POST", path: "/actions/target-fail" },
  "traffic-start": { method: "POST", path: "/traffic/start" },
  "traffic-stop": { method: "POST", path: "/traffic/stop" },
};

const error = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status });

/**
 * Refuses a credential the API says is bad. While Postgres restarts the API cannot say, and that is exactly when this
 * panel must keep working, so an answer other than 401 lets it through. This only ever runs on the local machine.
 */
async function credentialRefused(token: string): Promise<boolean> {
  try {
    await new MurphyApiClient({ apiUrl: apiUrl(), token }).request("GET", "/v1/scenarios");
    return false;
  } catch (err) {
    return err instanceof MurphyClientError && err.status === 401;
  }
}

async function handle(request: Request, name: string, method: string): Promise<Response> {
  // First, before anything else can happen.
  const guard = chaosGuard();
  if (!guard.ok) return error(403, "local_only", guard.reason);

  const action = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : undefined;
  if (!action || action.method !== method) return error(404, "not_found", "no such action");

  const credential = credentialFor(request);
  if (!credential) return error(401, "unauthorized", "Missing or invalid credentials.");
  if ("response" in credential) return credential.response;
  if (await credentialRefused(credential.token)) {
    return error(401, "unauthorized", "Missing or invalid credentials.");
  }

  let body: string | undefined;
  if (name === "target-fail") {
    const parsed = (await request.json().catch(() => null)) as { seconds?: unknown } | null;
    body = JSON.stringify({ seconds: parsed?.seconds });
  } else if (name === "traffic-start") {
    // Traffic runs as the signed-in project, so it shows in that project's delivery log.
    body = JSON.stringify({ token: credential.token });
  } else if (method === "POST") {
    body = "{}";
  }

  let res: Response;
  try {
    res = await fetch(`${controlUrl()}${action.path}`, {
      method,
      headers: {
        authorization: `Bearer ${process.env.MURPHY_CONTROL_TOKEN}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body,
      cache: "no-store",
    });
  } catch {
    return error(502, "control_unreachable", "The control service cannot be reached.");
  }
  const text = await res.text();
  if (res.ok) {
    return new Response(text, {
      status: res.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  let message = "The control service refused.";
  try {
    message = (JSON.parse(text) as { error: string }).error;
  } catch {
    // Keep the general message.
  }
  return error(res.status, "control_refused", message);
}

type Context = { params: Promise<{ action: string }> };

export async function GET(request: Request, context: Context) {
  return handle(request, (await context.params).action, "GET");
}

export async function POST(request: Request, context: Context) {
  return handle(request, (await context.params).action, "POST");
}
