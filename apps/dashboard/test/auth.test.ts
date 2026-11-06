import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as proxyGet, POST as proxyPost } from "@/app/api/v1/[...path]/route";
import { GET as callback } from "@/app/auth/github/callback/route";
import { POST as logout } from "@/app/auth/logout/route";
import { GET as start } from "@/app/auth/github/start/route";
import { POST as compare } from "@/app/api/compare/route";
import {
  authConfig,
  cookieNames,
  credentialFor,
  loginAllowed,
  parseCookies,
} from "@/lib/auth-server";

const ORIGIN = "https://murphy.example";
const env = {
  DASHBOARD_URL: ORIGIN,
  MURPHY_MODE: "hosted",
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  MURPHY_INTERNAL_SECRET: "internal-secret",
  GITHUB_ALLOWED_LOGINS: "udita-0707, Other",
  MURPHY_API_URL: "http://api",
};
const setEnv = (values: Record<string, string>) => {
  for (const [k, v] of Object.entries(values)) vi.stubEnv(k, v);
};

beforeEach(() => setEnv(env));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Call = { url: string; init: RequestInit };

/** A mocked GitHub and API. */
function world(over: { token?: Response; user?: Response; api?: Response } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/login/oauth/access_token")) {
      return over.token ?? Response.json({ access_token: "gho_secret_github_token" });
    }
    if (url.endsWith("/user")) return over.user ?? Response.json({ id: 42, login: "udita-0707" });
    if (url.endsWith("/internal/github-login")) {
      return over.api ?? Response.json({ token: "ms_session" }, { status: 201 });
    }
    return Response.json({ ok: true });
  });
  return calls;
}

function startFlow() {
  const res = start();
  const location = new URL(res.headers.get("location")!);
  const setCookie = res.headers.get("set-cookie")!;
  const value = /__Host-murphy_oauth=([^;]+)/.exec(setCookie)![1]!;
  return {
    res,
    location,
    setCookie,
    cookie: `__Host-murphy_oauth=${value}`,
    state: location.searchParams.get("state")!,
  };
}

const back = (query: string, cookie?: string) =>
  callback(
    new Request(`${ORIGIN}/auth/github/callback?${query}`, {
      headers: cookie ? { cookie } : {},
    }),
  );

describe("starting sign-in", () => {
  it("goes to GitHub with state, PKCE, the fixed callback and the least scope", () => {
    const { location, setCookie, state } = startFlow();
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/github/callback`);
    expect(location.searchParams.get("scope")).toBe("read:user");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(state.length).toBeGreaterThanOrEqual(43);
    expect(location.toString()).not.toContain("client-secret");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("gives a different state each time", () => {
    expect(startFlow().state).not.toBe(startFlow().state);
  });

  it("does not exist until GitHub is configured", () => {
    vi.stubEnv("GITHUB_CLIENT_ID", "");
    expect(start().status).toBe(404);
  });
});

describe("the callback", () => {
  it("signs in: httpOnly session, readable CSRF token, and the GitHub token stays behind", async () => {
    const calls = world();
    const { cookie, state } = startFlow();
    const res = await back(`code=abc&state=${state}`, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/scenarios`);

    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("__Host-murphy_session="))!;
    expect(session).toContain("ms_session");
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Lax");
    expect(session).toContain("Path=/");
    const csrf = cookies.find((c) => c.startsWith("__Host-murphy_csrf="))!;
    expect(csrf).not.toContain("HttpOnly");
    expect(cookies.find((c) => c.startsWith("__Host-murphy_oauth="))).toContain("Max-Age=0");

    // The GitHub token goes only to GitHub.
    expect(cookies.join()).not.toContain("gho_");
    const toApi = calls.find((c) => c.url.endsWith("/internal/github-login"))!;
    expect(JSON.parse(toApi.init.body as string)).toEqual({ github_id: 42, login: "udita-0707" });
    expect(new Headers(toApi.init.headers).get("x-murphy-internal")).toBe("internal-secret");
    expect(String(toApi.init.body)).not.toContain("gho_");
  });

  it("sends the PKCE verifier that matches the challenge", async () => {
    const calls = world();
    const { cookie, state, location } = startFlow();
    await back(`code=abc&state=${state}`, cookie);
    const sent = JSON.parse(calls[0]!.init.body as string) as { code_verifier: string };
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(sent.code_verifier),
    );
    expect(Buffer.from(digest).toString("base64url")).toBe(
      location.searchParams.get("code_challenge"),
    );
  });

  it.each([
    ["a state that does not match", (s: string) => `code=abc&state=${s}x`, true],
    ["no state", () => "code=abc", true],
    ["no cookie at all", (s: string) => `code=abc&state=${s}`, false],
  ])("refuses %s, and never calls GitHub", async (_name, query, withCookie) => {
    const calls = world();
    const { cookie, state } = startFlow();
    const res = await back(query(state), withCookie ? cookie : undefined);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/?login_error=state`);
    expect(res.headers.getSetCookie().join()).not.toContain("murphy_session");
    expect(calls).toEqual([]);
  });

  it("reports a cancelled sign-in, and shows nothing from the request", async () => {
    world();
    const { cookie, state } = startFlow();
    const res = await back(`error=<script>&state=${state}`, cookie);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/?login_error=denied`);
  });

  it("refuses a login that is not on the list, before making a session", async () => {
    const calls = world({ user: Response.json({ id: 9, login: "stranger" }) });
    const { cookie, state } = startFlow();
    const res = await back(`code=abc&state=${state}`, cookie);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/?login_error=not_allowed`);
    expect(calls.some((c) => c.url.includes("/internal/"))).toBe(false);
  });

  it.each([
    [
      "GitHub refusing the code",
      { token: Response.json({ error: "bad_verification_code" }) },
      "github",
    ],
    ["GitHub being down", { token: new Response("", { status: 500 }) }, "github"],
    ["a user with no id", { user: Response.json({ login: "x" }) }, "github"],
    ["the API refusing", { api: new Response("", { status: 500 }) }, "server"],
  ])("survives %s", async (_name, over, code) => {
    world(over);
    const { cookie, state } = startFlow();
    const res = await back(`code=abc&state=${state}`, cookie);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/?login_error=${code}`);
    expect(res.headers.getSetCookie().join()).not.toContain("murphy_session=ms_");
  });
});

describe("who may sign in", () => {
  it("hosted refuses everyone when the list is empty", () => {
    vi.stubEnv("GITHUB_ALLOWED_LOGINS", "");
    expect(loginAllowed(authConfig(), "udita-0707")).toBe(false);
  });
  it("local allows anyone when the list is empty", () => {
    setEnv({ GITHUB_ALLOWED_LOGINS: "", MURPHY_MODE: "local" });
    expect(loginAllowed(authConfig(), "anyone")).toBe(true);
  });
  it("the list ignores case", () => {
    expect(loginAllowed(authConfig(), "OTHER")).toBe(true);
  });
  it("an unset mode counts as hosted", () => {
    vi.stubEnv("MURPHY_MODE", undefined as unknown as string);
    vi.stubEnv("GITHUB_ALLOWED_LOGINS", "");
    expect(loginAllowed(authConfig(), "anyone")).toBe(false);
  });
});

describe("mock GitHub hosts", () => {
  it("are ignored in hosted mode", () => {
    setEnv({ GITHUB_WEB_URL: "http://evil", GITHUB_API_URL: "http://evil" });
    const config = authConfig();
    expect(config.githubWeb).toBe("https://github.com");
    expect(config.githubApi).toBe("https://api.github.com");
  });
  it("work in local mode, for tests", () => {
    setEnv({
      MURPHY_MODE: "local",
      GITHUB_WEB_URL: "http://mock:1/",
      GITHUB_API_URL: "http://mock:2",
    });
    const config = authConfig();
    expect(config.githubWeb).toBe("http://mock:1");
    expect(config.githubApi).toBe("http://mock:2");
  });
});

describe("cookie names", () => {
  it("use __Host- on https, and no prefix on plain http at localhost", () => {
    expect(cookieNames(authConfig()).session).toBe("__Host-murphy_session");
    vi.stubEnv("DASHBOARD_URL", "http://127.0.0.1:3100");
    const local = authConfig();
    expect(local.secure).toBe(false);
    expect(cookieNames(local).session).toBe("murphy_session");
  });
});

describe("a cookie-authenticated request", () => {
  const session = "__Host-murphy_session=ms_token; __Host-murphy_csrf=csrf123";
  const post = (headers: Record<string, string>) =>
    new Request(`${ORIGIN}/api/v1/x`, { method: "POST", headers, body: "{}" });
  const ctx = { params: Promise.resolve({ path: ["endpoints"] }) };

  it("reads freely, and becomes a bearer token on the way to the API", async () => {
    const calls = world();
    const res = await proxyGet(
      new Request(`${ORIGIN}/api/v1/x`, { headers: { cookie: session } }),
      ctx,
    );
    expect(res.status).toBe(200);
    const sent = new Headers(calls[0]!.init.headers);
    expect(sent.get("authorization")).toBe("Bearer ms_token");
    expect(sent.get("cookie")).toBeNull();
  });

  it("can change things with the right Origin and token", async () => {
    world();
    const res = await proxyPost(
      post({ cookie: session, origin: ORIGIN, "x-murphy-csrf": "csrf123" }),
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it.each([
    ["another site's Origin", { origin: "https://evil.example", "x-murphy-csrf": "csrf123" }],
    ["no Origin", { "x-murphy-csrf": "csrf123" }],
    ["no CSRF token", { origin: ORIGIN }],
    ["the wrong CSRF token", { origin: ORIGIN, "x-murphy-csrf": "nope" }],
  ])("refuses a change with %s, and calls nothing", async (_name, headers) => {
    const calls = world();
    const res = await proxyPost(post({ cookie: session, ...headers }), ctx);
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("the run-starting routes follow the same rule", async () => {
    const calls = world();
    const res = await compare(post({ cookie: session, origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("no session and no bearer means no credential", () => {
    expect(credentialFor(new Request(`${ORIGIN}/x`))).toBeNull();
  });
});

describe("API key login keeps working", () => {
  it("a bearer token needs no Origin or CSRF token, because no other site can send one", async () => {
    const calls = world();
    const res = await proxyPost(
      new Request(`${ORIGIN}/api/v1/x`, {
        method: "POST",
        headers: { authorization: "Bearer mk_key" },
        body: "{}",
      }),
      { params: Promise.resolve({ path: ["endpoints"] }) },
    );
    expect(res.status).toBe(200);
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer mk_key");
  });
});

describe("signing out", () => {
  const request = (headers: Record<string, string>) =>
    new Request(`${ORIGIN}/auth/logout`, {
      method: "POST",
      headers: { cookie: "__Host-murphy_session=ms_token; __Host-murphy_csrf=c", ...headers },
    });

  it("revokes the session, and clears both cookies", async () => {
    const calls = world();
    const res = await logout(request({ origin: ORIGIN, "x-murphy-csrf": "c" }));
    expect(res.status).toBe(204);
    const revoke = calls.find((c) => c.url.endsWith("/internal/session-revoke"))!;
    expect(JSON.parse(revoke.init.body as string)).toEqual({ token: "ms_token" });
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    for (const c of cookies) expect(c).toContain("Max-Age=0");
  });

  it("another site cannot sign someone out", async () => {
    const calls = world();
    const res = await logout(request({ origin: "https://evil.example", "x-murphy-csrf": "c" }));
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("still clears the cookies if the API is down", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("down");
    });
    const res = await logout(request({ origin: ORIGIN, "x-murphy-csrf": "c" }));
    expect(res.status).toBe(204);
  });
});

describe("parseCookies", () => {
  it("reads several", () => {
    const cookies = parseCookies(new Request("http://x", { headers: { cookie: "a=1; b=2=3" } }));
    expect(cookies.get("a")).toBe("1");
    expect(cookies.get("b")).toBe("2=3");
  });
});
