import { authConfig, cookie, cookieNames, credentialFor, parseCookies } from "@/lib/auth-server";
import { apiUrl } from "@/lib/server-config";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const config = authConfig();
  const names = cookieNames(config);
  const token = parseCookies(request).get(names.session);
  // Checks Origin and the CSRF token, so another site cannot sign someone out.
  const credential = credentialFor(
    new Request(request, { headers: withoutBearer(request) }),
    config,
  );
  if (credential && "response" in credential) return credential.response;

  if (token && config.internalSecret) {
    await fetch(`${apiUrl()}/internal/session-revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-murphy-internal": config.internalSecret,
      },
      body: JSON.stringify({ token }),
    }).catch(() => null);
  }
  const headers = new Headers({ "cache-control": "no-store" });
  headers.append("set-cookie", cookie(config, names.session, "", { maxAge: 0, httpOnly: true }));
  headers.append("set-cookie", cookie(config, names.csrf, "", { maxAge: 0, httpOnly: false }));
  return new Response(null, { status: 204, headers });
}

function withoutBearer(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  return headers;
}
