import { canonicalHash, verify } from "@murphy/core";
import { closeSync, openSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { decide, isProcessed } from "./decide.js";
import type { Profile, ReceiverRecord } from "./types.js";

/**
 * The flaky receiver, a separate process so its log is a source independent of Murphy. Every
 * arrival is written to the log on receipt, before the receiver acts on it. It runs both a naive
 * handler (applies every arrival) and an idempotent one (deduplicates on webhook-id).
 */

interface ReceiverConfig {
  seed: number;
  goneAfter: number;
  logPath: string;
  endpoints: { key: string; profile: Profile }[];
}

const config = JSON.parse(process.env.CHAOS_RECEIVER_CONFIG ?? "null") as ReceiverConfig | null;
if (!config) throw new Error("CHAOS_RECEIVER_CONFIG is not set");

const log = openSync(config.logPath, "a");
const profiles = new Map(config.endpoints.map((e) => [e.key, e.profile]));
const secrets = new Map<string, string>();
const arrivals = new Map<string, number>();
const applied = new Set<string>();
const goneAccepted = new Set<string>();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function respond(res: ServerResponse, status: number): void {
  if (res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ status }));
}

function handleWebhook(req: IncomingMessage, res: ServerResponse, key: string, body: string) {
  const profile = profiles.get(key);
  const secret = secrets.get(key);
  if (!profile || !secret) return respond(res, 404);

  const webhookId = header(req, "webhook-id") ?? "";
  const signatureValid = verify({
    id: webhookId,
    timestamp: header(req, "webhook-timestamp"),
    signature: header(req, "webhook-signature"),
    body,
    secret,
  }).valid;

  let parsed: { logical_id?: string; project?: string } = {};
  let payloadHash = "unparseable";
  try {
    parsed = JSON.parse(body) as typeof parsed;
    payloadHash = canonicalHash(parsed);
  } catch {
    // Left as unparseable: the checker reports it.
  }

  const arrivalKey = `${key}|${webhookId}`;
  const arrival = (arrivals.get(arrivalKey) ?? 0) + 1;
  arrivals.set(arrivalKey, arrival);

  const goneReached =
    profile === "gone" && goneAccepted.size >= config!.goneAfter && !goneAccepted.has(webhookId);
  const decision = signatureValid
    ? decide({ seed: config!.seed, endpoint: key, profile, webhookId, arrival, goneReached })
    : { action: "bad_signature" as const, delayMs: 0 };
  if (profile === "gone" && decision.action === "ok") goneAccepted.add(webhookId);

  const processed = isProcessed(decision.action);
  const idempotentApplied = processed && !applied.has(arrivalKey);
  if (idempotentApplied) applied.add(arrivalKey);

  const record: ReceiverRecord = {
    t: Date.now(),
    endpoint: key,
    webhookId,
    arrival,
    signatureValid,
    payloadHash,
    logicalId: parsed.logical_id ?? null,
    projectKey: parsed.project ?? null,
    eventType: header(req, "webhook-event-type") ?? null,
    action: decision.action,
    processed,
    idempotentApplied,
  };
  writeSync(log, JSON.stringify(record) + "\n");

  switch (decision.action) {
    case "ok":
      return respond(res, 200);
    case "slow":
    case "hang":
      setTimeout(() => respond(res, 200), decision.delayMs);
      return;
    case "fail_500":
    case "process_then_500":
      return respond(res, 500);
    case "process_then_reset":
      req.socket.destroy();
      return;
    case "gone_410":
      return respond(res, 410);
    case "bad_signature":
      return respond(res, 401);
  }
}

const server = createServer((req, res) => {
  void readBody(req).then((body) => {
    const url = req.url?.split("?")[0] ?? "";
    if (url === "/_register" && req.method === "POST") {
      const { key, secret } = JSON.parse(body) as { key: string; secret: string };
      secrets.set(key, secret);
      return respond(res, 200);
    }
    const match = /^\/hook\/([\w-]+)$/.exec(url);
    if (match && req.method === "POST") return handleWebhook(req, res, match[1]!, body);
    return respond(res, 404);
  });
});

server.listen(0, "127.0.0.1", () => {
  console.log(JSON.stringify({ port: (server.address() as AddressInfo).port }));
});

function stop(): void {
  closeSync(log);
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
