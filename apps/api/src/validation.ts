import { z } from "zod";
import { ApiError } from "./errors.js";

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) =>
        issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      )
      .join("; ");
    throw new ApiError(400, "validation_error", message);
  }
  return result.data;
}

export const uuidParam = z.object({ id: z.uuid() });

const eventType = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/, "must contain only letters, digits and . _ : -");

/** http(s) only. No outbound requests or address checks yet (SSRF protection is phase 2). */
const endpointUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
    } catch {
      return false;
    }
  }, "must be an http or https URL");

export const createEndpointBody = z.strictObject({
  url: endpointUrl,
  description: z.string().max(500).nullish(),
  event_filter: z.array(eventType).max(100).optional(),
});

export const updateEndpointBody = z
  .strictObject({
    url: endpointUrl.optional(),
    description: z.string().max(500).nullable().optional(),
    event_filter: z.array(eventType).max(100).optional(),
    status: z.enum(["active", "disabled", "paused"]).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "at least one field is required");

export const createEventBody = z.strictObject({
  type: eventType,
  payload: z.record(z.string(), z.unknown()),
});

export const idempotencyKey = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, "must be printable ASCII without spaces");

const deliveryStatus = z.enum(["pending", "in_flight", "succeeded", "failed", "dead", "cancelled"]);
const replayableStatus = z.enum(["succeeded", "failed", "dead"]);

/** Opaque keyset cursor: base64url of JSON [created_at ISO, id]. */
export function encodeCursor(cursor: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify([cursor.createdAt.toISOString(), cursor.id])).toString(
    "base64url",
  );
}

const cursorParam = z.string().transform((value, ctx) => {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const parsed = z.tuple([z.iso.datetime(), z.uuid()]).parse(decoded);
    return { createdAt: new Date(parsed[0]), id: parsed[1] };
  } catch {
    ctx.addIssue({ code: "custom", message: "invalid cursor" });
    return z.NEVER;
  }
});

const limitParam = z.coerce.number().int().min(1).max(100).default(50);

export const listDeliveriesQuery = z.strictObject({
  status: deliveryStatus.optional(),
  endpoint_id: z.uuid().optional(),
  event_id: z.uuid().optional(),
  limit: limitParam,
  cursor: cursorParam.optional(),
});

export const listDlqQuery = z.strictObject({
  endpoint_id: z.uuid().optional(),
  limit: limitParam,
  cursor: cursorParam.optional(),
});

export const bulkReplayBody = z
  .strictObject({
    status: z.union([replayableStatus, z.array(replayableStatus).min(1)]).default("dead"),
    endpoint_id: z.uuid().optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .refine(
    (b) => !b.from || !b.to || Date.parse(b.from) < Date.parse(b.to),
    "from must be before to",
  );

export const dlqRetryBody = z.strictObject({
  endpoint_id: z.uuid().optional(),
});
