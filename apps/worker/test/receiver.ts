import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { verify } from "@murphy/core";

export interface Received {
  headers: IncomingMessage["headers"];
  body: string;
  valid: boolean;
}

export type Reply = (req: IncomingMessage, res: ServerResponse) => void;

/** A test receiver that records requests, verifies signatures and replies from a script. */
export class StubReceiver {
  readonly received: Received[] = [];
  private replies: Reply[] = [];
  private fallback: Reply = (_req, res) => res.end("ok");
  private server: Server | null = null;
  url = "";

  constructor(private readonly secret: string) {}

  /** Replies for the next requests, in order; afterwards the fallback (200 "ok") is used. */
  script(...replies: Reply[]): void {
    this.replies = replies;
  }

  setFallback(reply: Reply): void {
    this.fallback = reply;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const result = verify({
          id: req.headers["webhook-id"] as string | undefined,
          timestamp: req.headers["webhook-timestamp"] as string | undefined,
          signature: req.headers["webhook-signature"] as string | undefined,
          body,
          secret: this.secret,
          toleranceSeconds: 10 * 365 * 24 * 3600, // tests may use a fake clock
        });
        this.received.push({ headers: req.headers, body, valid: result.valid });
        (this.replies.shift() ?? this.fallback)(req, res);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/webhooks`;
    return this.url;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

export const status =
  (code: number, headers: Record<string, string> = {}, body = ""): Reply =>
  (_req, res) =>
    res.writeHead(code, headers).end(body);

export const hang: Reply = () => {};
