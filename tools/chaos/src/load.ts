import { canonicalHash } from "@murphy/core";
import type { ClientRecord, PlanEvent } from "./types.js";

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_BACKOFF_MS = 1_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function payloadOf(event: PlanEvent) {
  return {
    logical_id: event.logicalId,
    project: event.projectKey,
    seq: event.seq,
    amount: event.amount,
  };
}

interface Accepted {
  id: string;
  deliveries: number;
}

/**
 * The load generator, and the client-side source of truth: it logs every request and every 202 it
 * actually received. It behaves like a careful client: retry with the same Idempotency-Key until a
 * 202 or the deadline. A timed-out request may still have committed, which is the case retrying
 * with the same key exists for.
 */
export async function sendEvent(options: {
  apiUrl: () => string;
  apiKey: string;
  event: PlanEvent;
  deadline: number;
  log: (record: ClientRecord) => void;
}): Promise<void> {
  const { apiKey, event, deadline, log } = options;
  const payload = payloadOf(event);
  const payloadHash = canonicalHash(payload);

  const attempt = async (tryNumber: number, deliberateResend: boolean): Promise<boolean> => {
    log({
      kind: "send",
      t: Date.now(),
      key: event.idempotencyKey,
      logicalId: event.logicalId,
      projectKey: event.projectKey,
      type: event.type,
      payloadHash,
      try: tryNumber,
      deliberateResend,
    });
    try {
      const response = await fetch(`${options.apiUrl()}/v1/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "idempotency-key": event.idempotencyKey,
        },
        body: JSON.stringify({ type: event.type, payload }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 202) {
        const body = (await response.json()) as Accepted;
        log({
          kind: "ack",
          t: Date.now(),
          key: event.idempotencyKey,
          eventId: body.id,
          deliveries: body.deliveries,
          replayed: response.headers.get("idempotent-replayed") === "true",
        });
        return true;
      }
      await response.text();
      log({
        kind: "error",
        t: Date.now(),
        key: event.idempotencyKey,
        detail: `HTTP ${response.status}`,
      });
    } catch (err) {
      log({ kind: "error", t: Date.now(), key: event.idempotencyKey, detail: String(err) });
    }
    return false;
  };

  const untilAcked = async (deliberateResend: boolean): Promise<boolean> => {
    for (let tryNumber = 1; Date.now() < deadline; tryNumber++) {
      if (await attempt(tryNumber, deliberateResend)) return true;
      await sleep(Math.min(MAX_BACKOFF_MS, 100 * 2 ** tryNumber));
    }
    return false;
  };

  if (!(await untilAcked(false))) {
    log({ kind: "gave_up", t: Date.now(), key: event.idempotencyKey });
    return;
  }
  if (event.resend) await untilAcked(true);
}
