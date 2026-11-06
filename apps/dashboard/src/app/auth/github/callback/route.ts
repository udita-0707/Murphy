import { randomBytes } from "node:crypto";
import {
  authConfig,
  cookie,
  cookieNames,
  githubConfigured,
  loginAllowed,
  parseCookies,
  safeEqual,
  type AuthConfig,
} from "@/lib/auth-server";
import { apiUrl } from "@/lib/server-config";

export const dynamic = "force-dynamic";

const TWELVE_HOURS = 12 * 60 * 60;

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const value of cookies) headers.append("set-cookie", value);
  return new Response(null, { status: 303, headers });
}

/** Fixed codes only: nothing from the request is ever shown back on the sign-in page. */
const fail = (config: AuthConfig, code: string, clear: string) =>
  redirect(`${config.origin}/login?login_error=${code}`, [clear]);

async function githubUser(
  config: AuthConfig,
  code: string,
  verifier: string,
): Promise<{ id: number; login: string } | null> {
  const exchanged = await fetch(`${config.githubWeb}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: `${config.origin}/auth/github/callback`,
    }),
  });
  if (!exchanged.ok) return null;
  const token = ((await exchanged.json()) as { access_token?: unknown }).access_token;
  if (typeof token !== "string" || !token) return null;
  const user = await fetch(`${config.githubApi}/user`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "murphy-dashboard",
    },
  });
  if (!user.ok) return null;
  const body = (await user.json()) as { id?: unknown; login?: unknown };
  // The GitHub token goes out of scope here. It is never stored.
  if (typeof body.id !== "number" || typeof body.login !== "string") return null;
  return { id: body.id, login: body.login };
}

export async function GET(request: Request) {
  const config = authConfig();
  if (!githubConfigured(config)) return new Response(null, { status: 404 });
  const names = cookieNames(config);
  const clear = cookie(config, names.oauth, "", { maxAge: 0, httpOnly: true });
  const url = new URL(request.url);

  const stored = parseCookies(request).get(names.oauth) ?? "";
  const [expectedState, verifier] = stored.split(".");
  const state = url.searchParams.get("state");
  if (!expectedState || !verifier || !state || !safeEqual(state, expectedState)) {
    return fail(config, "state", clear);
  }
  if (url.searchParams.get("error")) return fail(config, "denied", clear);
  const code = url.searchParams.get("code");
  if (!code) return fail(config, "github", clear);

  let user: { id: number; login: string } | null;
  try {
    user = await githubUser(config, code, verifier);
  } catch {
    return fail(config, "github", clear);
  }
  if (!user) return fail(config, "github", clear);
  if (!loginAllowed(config, user.login)) return fail(config, "not_allowed", clear);

  let session: { token: string };
  try {
    const res = await fetch(`${apiUrl()}/internal/github-login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-murphy-internal": config.internalSecret!,
      },
      body: JSON.stringify({ github_id: user.id, login: user.login }),
    });
    if (!res.ok) return fail(config, "server", clear);
    session = (await res.json()) as { token: string };
  } catch {
    return fail(config, "server", clear);
  }

  return redirect(`${config.origin}/scenarios`, [
    clear,
    cookie(config, names.session, session.token, { maxAge: TWELVE_HOURS, httpOnly: true }),
    // Readable by the page, by design: it is the double-submit token, and proves nothing alone.
    cookie(config, names.csrf, randomBytes(32).toString("base64url"), {
      maxAge: TWELVE_HOURS,
      httpOnly: false,
    }),
  ]);
}
