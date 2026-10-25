import { decryptSecret, signHeaders } from "@murphy/core";
import type { ClaimedDelivery, DeliveryQueue } from "@murphy/db";
import { sendWebhook } from "./net/send.js";
import type { MurphyMode, Resolver } from "./net/ssrf.js";
import { decideOutcome } from "./policy.js";
import type { DeliveryHandler } from "./worker.js";

export const USER_AGENT = "Murphy-Webhooks/0.1";
/** Carries the event type outside the raw payload (ADR 006). Not covered by the signature. */
export const EVENT_TYPE_HEADER = "webhook-event-type";

export interface DeliverOptions {
  queue: DeliveryQueue;
  workerId: string;
  encryptionKey: Buffer;
  mode: MurphyMode;
  requestTimeoutMs: number;
  resolver?: Resolver;
  /** Clock for webhook-timestamp; injectable for tests. */
  now?: () => Date;
  random?: () => number;
  onAttempt?: (info: {
    deliveryId: string;
    attemptNo: number;
    outcome: string;
    status: number | null;
  }) => void;
}

/** The webhook-id for an event: stable across retries, reaps and replays (ADR 006). */
export function webhookId(eventId: string): string {
  return `msg_${eventId}`;
}

/**
 * Sends one attempt for a claimed delivery: decrypts the endpoint secret (only here, in the
 * worker), signs with a fresh timestamp, sends through the SSRF guard, logs the attempt and
 * applies the retry policy with a guarded write.
 */
export function createDeliveryHandler(options: DeliverOptions): DeliveryHandler {
  const now = options.now ?? (() => new Date());
  return async (claimed: ClaimedDelivery, signal: AbortSignal) => {
    const { queue, workerId } = options;
    const ctx = await queue.loadContext(claimed.id, workerId);
    if (!ctx) return; // Cancelled or reaped since the claim.

    const body = JSON.stringify(ctx.payload);
    const startedAt = now();
    const timestamp = Math.floor(startedAt.getTime() / 1000);
    const secret = decryptSecret(ctx.secretEnc, options.encryptionKey);
    const headers = {
      ...signHeaders({ id: webhookId(ctx.eventId), timestamp, body, secrets: [secret] }),
      [EVENT_TYPE_HEADER]: ctx.eventType,
      "user-agent": USER_AGENT,
    };

    const result = await sendWebhook({
      url: ctx.endpointUrl,
      headers,
      body,
      mode: options.mode,
      timeoutMs: options.requestTimeoutMs,
      resolver: options.resolver,
      signal,
    });
    const outcome = decideOutcome(result, ctx, { random: options.random });

    const { attemptNo } = await queue.recordAttempt(
      claimed.id,
      workerId,
      {
        startedAt,
        durationMs: result.durationMs,
        requestHeaders: { ...headers, "content-type": "application/json" },
        responseStatus: result.ok ? result.status : null,
        responseBodySnippet: result.ok ? result.bodySnippet : null,
        error: result.ok
          ? null
          : result.kind === "aborted"
            ? "worker_shutdown"
            : `${result.kind}: ${result.error}`,
      },
      outcome,
    );
    options.onAttempt?.({
      deliveryId: claimed.id,
      attemptNo,
      outcome: outcome.kind,
      status: result.ok ? result.status : null,
    });
  };
}
