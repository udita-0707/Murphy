"use client";

import { getApiKey, setApiKey } from "./session";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** A request from the browser, always to this origin (ADR 013). */
export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = getApiKey();
  const headers = new Headers(init.headers);
  if (key) headers.set("authorization", `Bearer ${key}`);
  if (init.body) headers.set("content-type", "application/json");
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, cache: "no-store" });
  } catch {
    throw new ApiRequestError("This page lost contact with its server.", 0, "network");
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text || `The request failed with status ${res.status}.`;
    let code: string | null = null;
    try {
      const parsed = JSON.parse(text) as { error: { message: string; code?: string } };
      message = parsed.error.message;
      code = parsed.error.code ?? null;
    } catch {
      // Not our error format, so show it as it is.
    }
    // A key that stopped working: back to the sign-in page, once it is not the sign-in itself.
    if (res.status === 401 && key) setApiKey(null);
    throw new ApiRequestError(message, res.status, code);
  }
  if (res.headers.get("content-type")?.includes("json")) return JSON.parse(text) as T;
  return text as T;
}
