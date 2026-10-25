import type { LookupFunction } from "node:net";
import { Agent, request } from "undici";
import { type MurphyMode, type Resolver, safeTarget, SsrfError, systemResolver } from "./ssrf.js";

/** Only this much of the response body is read, then the stream is cancelled. */
export const MAX_BODY_SNIPPET_BYTES = 1024;

export interface SendInput {
  url: string;
  headers: Record<string, string>;
  body: string;
  mode: MurphyMode;
  /** Total budget for connect, headers and body. */
  timeoutMs: number;
  resolver?: Resolver;
  /** Aborts the request early (worker shutdown). */
  signal?: AbortSignal;
}

export type SendResult =
  | {
      ok: true;
      status: number;
      retryAfter: string | null;
      bodySnippet: string;
      durationMs: number;
    }
  | {
      ok: false;
      kind: "ssrf_blocked" | "timeout" | "network" | "aborted";
      error: string;
      durationMs: number;
    };

/**
 * Sends one webhook POST after SSRF validation, with the connection pinned to the validated
 * IP (Host header and TLS SNI keep the hostname). Redirects are never followed: a 3xx comes
 * back as a status like any other.
 */
export async function sendWebhook(input: SendInput): Promise<SendResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  let target;
  try {
    target = await safeTarget(input.url, input.mode, input.resolver ?? systemResolver);
  } catch (err) {
    if (err instanceof SsrfError) {
      return {
        ok: false,
        kind: "ssrf_blocked",
        error: `${err.reason}: ${err.message}`,
        durationMs: elapsed(),
      };
    }
    throw err;
  }

  const { address, family } = target.pinned;
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
        { address, family },
      ]);
    } else {
      callback(null, address, family);
    }
  };
  const agent = new Agent({ connect: { lookup: pinnedLookup }, connections: 1, pipelining: 0 });

  const timeout = AbortSignal.timeout(input.timeoutMs);
  const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
  try {
    const res = await request(target.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...input.headers },
      body: input.body,
      dispatcher: agent,
      signal,
    });
    const bodySnippet = await readSnippet(res.body);
    const retryAfter = res.headers["retry-after"];
    return {
      ok: true,
      status: res.statusCode,
      retryAfter: Array.isArray(retryAfter) ? (retryAfter[0] ?? null) : (retryAfter ?? null),
      bodySnippet,
      durationMs: elapsed(),
    };
  } catch (err) {
    if (input.signal?.aborted) {
      return { ok: false, kind: "aborted", error: "worker shutting down", durationMs: elapsed() };
    }
    if (timeout.aborted) {
      return {
        ok: false,
        kind: "timeout",
        error: `timed out after ${input.timeoutMs} ms`,
        durationMs: elapsed(),
      };
    }
    return { ok: false, kind: "network", error: describe(err), durationMs: elapsed() };
  } finally {
    void agent.destroy().catch(() => {});
  }
}

async function readSnippet(body: AsyncIterable<Buffer> & { destroy(): void }): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= MAX_BODY_SNIPPET_BYTES) break;
  }
  body.destroy();
  return Buffer.concat(chunks).subarray(0, MAX_BODY_SNIPPET_BYTES).toString("utf8");
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    const cause = err.cause instanceof Error ? `: ${err.cause.message}` : "";
    return `${code ? `${code} ` : ""}${err.message}${cause}`;
  }
  return String(err);
}
