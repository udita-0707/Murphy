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
