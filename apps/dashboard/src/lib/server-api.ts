import { MurphyApiClient, MurphyClientError } from "@murphy/client";
import { credentialFor } from "./auth-server";
import { apiUrl } from "./server-config";

/** The caller's own credential, forwarded. These routes have no authority of their own. */
export function clientFor(request: Request): { api: MurphyApiClient } | { response: Response } {
  const credential = credentialFor(request);
  if (!credential) return { response: unauthorized() };
  if ("response" in credential) return credential;
  return { api: new MurphyApiClient({ apiUrl: apiUrl(), token: credential.token }) };
}

export const unauthorized = () =>
  Response.json(
    { error: { code: "unauthorized", message: "Missing or invalid credentials." } },
    { status: 401 },
  );

export const badRequest = (message: string) =>
  Response.json({ error: { code: "invalid_request", message } }, { status: 400 });

/** Keeps the API's own status, and never shows a stack. */
export function failure(err: unknown): Response {
  if (err instanceof MurphyClientError) {
    const status = err.kind === "api_error" ? (err.status ?? 502) : 502;
    return Response.json(
      { error: { code: err.code ?? err.kind, message: err.message } },
      { status },
    );
  }
  console.error(err);
  return Response.json(
    { error: { code: "internal_error", message: "Something went wrong." } },
    { status: 500 },
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
export const isSeed = (value: unknown): value is number | undefined =>
  value === undefined ||
  (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647);
