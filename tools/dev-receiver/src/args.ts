import { parseArgs } from "node:util";
import type { ReceiverOptions } from "./receiver.js";

export const USAGE = `Usage: pnpm receiver [options]

Options (flags win over environment variables):
  --port <n>          Port to listen on            (RECEIVER_PORT, default 4242)
  --secret <whsec_>   Endpoint signing secret      (RECEIVER_SECRET; without it signatures are not checked)
  --fail <n>          Fail the next n requests     (RECEIVER_FAIL, default 0)
  --status <code>     Status used for failures     (RECEIVER_STATUS, default 500)
  --delay-ms <n>      Delay before each response   (RECEIVER_DELAY_MS, default 0)
  --retry-after <s>   Retry-After on failures      (RECEIVER_RETRY_AFTER)
  --help

Change behaviour at runtime:
  curl -X POST localhost:4242/_control -d '{"fail":3,"status":503}'
  curl localhost:4242/_control`;

/** Parses CLI flags and environment variables into receiver options. */
export function parseReceiverArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
): ReceiverOptions | "help" {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string" },
      secret: { type: "string" },
      fail: { type: "string" },
      status: { type: "string" },
      "delay-ms": { type: "string" },
      "retry-after": { type: "string" },
      help: { type: "boolean" },
    },
    strict: true,
  });
  if (values.help) return "help";
  const int = (
    name: string,
    raw: string | undefined,
    fallback: number | null,
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
  ) => {
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`--${name} must be an integer between ${min} and ${max}`);
    return n;
  };
  return {
    port: int("port", values.port ?? env.RECEIVER_PORT, 4242, 0, 65535)!,
    secret: values.secret ?? (env.RECEIVER_SECRET || undefined),
    fail: int("fail", values.fail ?? env.RECEIVER_FAIL, 0)!,
    status: int("status", values.status ?? env.RECEIVER_STATUS, 500, 100, 599)!,
    delayMs: int("delay-ms", values["delay-ms"] ?? env.RECEIVER_DELAY_MS, 0)!,
    retryAfter: int("retry-after", values["retry-after"] ?? env.RECEIVER_RETRY_AFTER, null),
  };
}
