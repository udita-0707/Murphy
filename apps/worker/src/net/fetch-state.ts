import type { LookupFunction } from "node:net";
import { Agent, request } from "undici";
import { type MurphyMode, type Resolver, safeTarget, SsrfError, systemResolver } from "./ssrf.js";

export const MAX_STATE_BYTES = 256 * 1024;

export interface FetchStateInput {
  stateUrl: string;
  runId: string;
  mode: MurphyMode;
  timeoutMs: number;
  resolver?: Resolver;
}

export type FetchStateResult = { ok: true; body: unknown } | { ok: false; error: string };

/**
 * Reads a target's state for a run. It follows the same rules as a delivery: the SSRF guard, a connection
 * pinned to the validated address, no redirects, and bounded time and size.
 */
export async function fetchTargetState(input: FetchStateInput): Promise<FetchStateResult> {
  let url: URL;
  try {
    url = new URL(input.stateUrl);
  } catch {
    return { ok: false, error: "the state URL is not valid" };
  }
  url.searchParams.set("run_id", input.runId);

  let target;
  try {
    target = await safeTarget(url.toString(), input.mode, input.resolver ?? systemResolver);
  } catch (err) {
    if (err instanceof SsrfError) return { ok: false, error: `blocked: ${err.message}` };
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
  try {
    const res = await request(target.url, {
      method: "GET",
      dispatcher: agent,
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      chunks.push(chunk as Buffer);
      size += (chunk as Buffer).length;
      if (size > MAX_STATE_BYTES) {
        res.body.destroy();
        return { ok: false, error: `the state response is larger than ${MAX_STATE_BYTES} bytes` };
      }
    }
    if (res.statusCode !== 200) {
      return { ok: false, error: `the state endpoint answered ${res.statusCode}` };
    }
    try {
      return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    } catch {
      return { ok: false, error: "the state response is not JSON" };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    void agent.destroy().catch(() => {});
  }
}
