import { createHash, randomBytes } from "node:crypto";
import { authConfig, cookie, cookieNames, githubConfigured } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

const TEN_MINUTES = 600;

export function GET() {
  const config = authConfig();
  if (!githubConfigured(config)) {
    return new Response(null, { status: 404 });
  }
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${config.githubWeb}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", config.clientId!);
  authorize.searchParams.set("redirect_uri", `${config.origin}/auth/github/callback`);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.toString(),
      "cache-control": "no-store",
      "set-cookie": cookie(config, cookieNames(config).oauth, `${state}.${verifier}`, {
        maxAge: TEN_MINUTES,
        httpOnly: true,
      }),
    },
  });
}
