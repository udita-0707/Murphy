import { timingSafeEqual } from "node:crypto";

/** Server side only: GitHub login and session cookies (ADR 014). */
export interface AuthConfig {
  /** The dashboard's public origin. The only origin trusted, and the base of the callback URL. */
  origin: string;
  secure: boolean;
  mode: "local" | "hosted";
  clientId: string | null;
  clientSecret: string | null;
  internalSecret: string | null;
  /** GitHub's web and API hosts. Only a local run can point these at a mock. */
  githubWeb: string;
  githubApi: string;
  allowedLogins: Set<string> | null;
}

const trim = (url: string) => url.replace(/\/$/, "");

export function authConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const origin = trim(env.DASHBOARD_URL ?? "http://127.0.0.1:3100");
  const mode = env.MURPHY_MODE === "local" ? "local" : "hosted";
  const list = env.GITHUB_ALLOWED_LOGINS?.split(",")
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);
  return {
    origin,
    secure: origin.startsWith("https://"),
    mode,
    clientId: env.GITHUB_CLIENT_ID || null,
    clientSecret: env.GITHUB_CLIENT_SECRET || null,
    internalSecret: env.MURPHY_INTERNAL_SECRET || null,
    githubWeb: trim((mode === "local" && env.GITHUB_WEB_URL) || "https://github.com"),
    githubApi: trim((mode === "local" && env.GITHUB_API_URL) || "https://api.github.com"),
    allowedLogins: list && list.length > 0 ? new Set(list) : null,
  };
}

export const githubConfigured = (config: AuthConfig) =>
  Boolean(config.clientId && config.clientSecret && config.internalSecret);

/** Hosted is closed unless a login is listed. Open sign-up would let strangers send webhooks. */
export function loginAllowed(config: AuthConfig, login: string): boolean {
  if (config.allowedLogins) return config.allowedLogins.has(login.toLowerCase());
  return config.mode === "local";
}

/** `__Host-` needs Secure, which plain http on this machine cannot have. */
export const cookieNames = (config: AuthConfig) =>
  config.secure
    ? {
        session: "__Host-murphy_session",
        oauth: "__Host-murphy_oauth",
        csrf: "__Host-murphy_csrf",
      }
    : { session: "murphy_session", oauth: "murphy_oauth", csrf: "murphy_csrf" };

export function parseCookies(request: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) out.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return out;
}

export function cookie(
  config: AuthConfig,
  name: string,
  value: string,
  options: { maxAge: number; httpOnly: boolean },
): string {
  return [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${options.maxAge}`,
    "SameSite=Lax",
    ...(options.httpOnly ? ["HttpOnly"] : []),
    ...(config.secure ? ["Secure"] : []),
  ].join("; ");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type Credential = { token: string } | { response: Response };

const refuse = (status: number, code: string, message: string) => ({
  response: Response.json({ error: { code, message } }, { status }),
});

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The caller's credential. A bearer token is sent by script, so another site cannot make a browser send
 * it. A cookie is sent automatically, so a change made with one needs both a matching Origin and the
 * double-submit token.
 */
export function credentialFor(request: Request, config = authConfig()): Credential | null {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  if (bearer?.[1]) return { token: bearer[1] };

  const names = cookieNames(config);
  const cookies = parseCookies(request);
  const session = cookies.get(names.session);
  if (!session) return null;
  if (!SAFE_METHODS.has(request.method)) {
    if (request.headers.get("origin") !== config.origin) {
      return refuse(403, "bad_origin", "This request did not come from the dashboard.");
    }
    const sent = request.headers.get("x-murphy-csrf") ?? "";
    const expected = cookies.get(names.csrf) ?? "";
    if (!expected || !safeEqual(sent, expected)) {
      return refuse(403, "bad_csrf_token", "This request is missing its CSRF token.");
    }
  }
  return { token: session };
}
