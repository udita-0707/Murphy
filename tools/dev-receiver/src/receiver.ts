import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { verify, type VerifyResult } from "@murphy/core";

export interface Behaviour {
  /** Fail the next N webhook requests with `status`, then succeed. */
  fail: number;
  /** Status for failed requests. */
  status: number;
  /** Delay before every response. */
  delayMs: number;
  /** Retry-After header (seconds) sent with failures, if set. */
  retryAfter: number | null;
}

export interface ReceiverOptions extends Partial<Behaviour> {
  port: number;
  host?: string;
  /** Endpoint signing secret (whsec_...). Without it signatures are not checked. */
  secret?: string;
  log?: (line: string) => void;
}

export interface ReceivedWebhook {
  webhookId: string | undefined;
  signature: "valid" | "invalid" | "unchecked";
  reason?: string;
  duplicate: boolean;
  status: number;
  body: string;
}

export interface Receiver {
  url: string;
  behaviour: Behaviour;
  received: ReceivedWebhook[];
  close(): Promise<void>;
}

const DEFAULTS: Behaviour = { fail: 0, status: 500, delayMs: 0, retryAfter: null };

/**
 * A local webhook receiver for trying Murphy end to end. Every POST is verified with the
 * endpoint secret and logged as valid or invalid; repeated webhook-ids are flagged as
 * duplicates. Behaviour (failures, status, delay, Retry-After) can be changed at runtime with
 * POST /_control.
 */
export async function startReceiver(options: ReceiverOptions): Promise<Receiver> {
  const log = options.log ?? ((line: string) => console.log(line));
  const behaviour: Behaviour = {
    fail: options.fail ?? DEFAULTS.fail,
    status: options.status ?? DEFAULTS.status,
    delayMs: options.delayMs ?? DEFAULTS.delayMs,
    retryAfter: options.retryAfter ?? DEFAULTS.retryAfter,
  };
  const received: ReceivedWebhook[] = [];
  const seen = new Set<string>();

  const server: Server = createServer((req, res) => {
    void readBody(req).then((body) => {
      if (req.url?.split("?")[0] === "/_control") return control(req, res, body);
      if (req.method !== "POST") return json(res, 405, { error: "POST webhooks here" });
      return handleWebhook(req, res, body);
    });
  });

  async function handleWebhook(req: IncomingMessage, res: ServerResponse, body: string) {
    const webhookId = header(req, "webhook-id");
    let signature: ReceivedWebhook["signature"] = "unchecked";
    let reason: string | undefined;
    if (options.secret) {
      const result: VerifyResult = verify({
        id: webhookId,
        timestamp: header(req, "webhook-timestamp"),
        signature: header(req, "webhook-signature"),
        body,
        secret: options.secret,
      });
      signature = result.valid ? "valid" : "invalid";
      if (!result.valid) reason = result.reason;
    }
    const duplicate = webhookId !== undefined && seen.has(webhookId);
    if (webhookId) seen.add(webhookId);

    if (behaviour.delayMs > 0) await sleep(behaviour.delayMs);

    let status = 200;
    const headers: Record<string, string> = {};
    if (signature === "invalid") {
      status = 401;
    } else if (behaviour.fail > 0) {
      behaviour.fail -= 1;
      status = behaviour.status;
      if (behaviour.retryAfter !== null) headers["retry-after"] = String(behaviour.retryAfter);
    }
    received.push({ webhookId, signature, reason, duplicate, status, body });
    log(
      [
        `[receiver] ${new Date().toISOString()}`,
        `id=${webhookId ?? "-"}`,
        `signature=${signature}${reason ? ` (${reason})` : ""}`,
        duplicate ? "DUPLICATE" : "",
        `-> ${status}`,
        behaviour.fail > 0 ? `(${behaviour.fail} more failures queued)` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(status === 200 ? { ok: true } : { ok: false, status }));
  }

  function control(req: IncomingMessage, res: ServerResponse, body: string) {
    if (req.method === "POST") {
      let patch: Record<string, unknown>;
      try {
        patch = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      } catch {
        return json(res, 400, { error: "body must be JSON" });
      }
      const error = applyPatch(behaviour, patch);
      if (error) return json(res, 400, { error });
      log(`[receiver] behaviour changed: ${JSON.stringify(behaviour)}`);
    } else if (req.method !== "GET") {
      return json(res, 405, { error: "use GET or POST" });
    }
    return json(res, 200, {
      behaviour,
      received: received.length,
      valid: received.filter((r) => r.signature === "valid").length,
      invalid: received.filter((r) => r.signature === "invalid").length,
      duplicates: received.filter((r) => r.duplicate).length,
    });
  }

  await new Promise<void>((resolve) =>
    server.listen(options.port, options.host ?? "127.0.0.1", resolve),
  );
  const address = server.address() as AddressInfo;
  return {
    url: `http://${options.host ?? "127.0.0.1"}:${address.port}/webhooks`,
    behaviour,
    received,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Applies a POST /_control body. Returns an error message for invalid input. */
export function applyPatch(behaviour: Behaviour, patch: Record<string, unknown>): string | null {
  const next = { ...behaviour };
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case "fail":
      case "delayMs":
        if (!Number.isInteger(value) || (value as number) < 0)
          return `${key} must be a non-negative integer`;
        next[key] = value as number;
        break;
      case "status":
        if (!Number.isInteger(value) || (value as number) < 100 || (value as number) > 599)
          return "status must be an HTTP status code";
        next.status = value as number;
        break;
      case "retryAfter":
        if (value !== null && (!Number.isInteger(value) || (value as number) < 0))
          return "retryAfter must be a non-negative integer or null";
        next.retryAfter = value as number | null;
        break;
      default:
        return `unknown setting "${key}" (use fail, status, delayMs, retryAfter)`;
    }
  }
  Object.assign(behaviour, next);
  return null;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
