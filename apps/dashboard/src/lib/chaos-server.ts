import { checkLocalOnly, type GuardResult } from "@murphy/core";

/**
 * The dashboard applies the same guard as the control service, independently (ADR 015). Either one alone
 * refuses. The token is random per start, and `pnpm demo:stack` is the only thing that sets it.
 */
export function chaosGuard(env: NodeJS.ProcessEnv = process.env): GuardResult {
  const local = checkLocalOnly(env, "the chaos panel");
  if (!local.ok) return local;
  if (!env.MURPHY_CONTROL_TOKEN) {
    return { ok: false, reason: "the control service is not running. Start with pnpm demo:stack" };
  }
  return { ok: true };
}

export function controlUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MURPHY_CONTROL_URL ?? "http://127.0.0.1:4545").replace(/\/$/, "");
}
