import { parseMode } from "./address.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export type GuardResult = { ok: true } | { ok: false; reason: string };

/**
 * For anything that can destroy data or break processes. It only runs when both are true: MURPHY_MODE is
 * explicitly "local" (unset means hosted, the default) and DATABASE_URL points at this machine.
 */
export function checkLocalOnly(env: NodeJS.ProcessEnv, name: string): GuardResult {
  let mode;
  try {
    mode = parseMode(env.MURPHY_MODE);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (mode !== "local") {
    return {
      ok: false,
      reason: `MURPHY_MODE is "${env.MURPHY_MODE || "hosted (unset)"}"; ${name} only runs with MURPHY_MODE=local`,
    };
  }
  if (!env.DATABASE_URL) return { ok: false, reason: "DATABASE_URL is not set" };
  let host: string;
  try {
    host = new URL(env.DATABASE_URL).hostname;
  } catch {
    return { ok: false, reason: "DATABASE_URL is not a valid URL" };
  }
  if (!LOCAL_HOSTS.has(host)) {
    return {
      ok: false,
      reason: `DATABASE_URL points to "${host}"; ${name} only runs against localhost`,
    };
  }
  return { ok: true };
}
