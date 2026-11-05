import type { PrismaClient } from "@murphy/db";
import type { ClientRecord } from "./types.js";

/**
 * Negative controls. Each damages the database during a run the way a real bug would, and the
 * named invariant must then fail. If it does not, a pass from the harness means nothing.
 */
export type SabotageMode = "lost-event" | "fake-success";

export function isSabotage(value: string | undefined): value is SabotageMode {
  return value === "lost-event" || value === "fake-success";
}

export function expectedFailure(mode: SabotageMode): string {
  return mode === "lost-event" ? "I1" : "I5";
}

export async function sabotage(
  prisma: PrismaClient,
  mode: SabotageMode,
  client: ClientRecord[],
  endpointIds: Record<string, string>,
): Promise<string> {
  if (mode === "lost-event") {
    // An event the client holds a 202 for vanishes, as if the commit had never been durable.
    const ack = client.find((r) => r.kind === "ack");
    if (!ack || ack.kind !== "ack") throw new Error("no 202 received yet");
    await prisma.$executeRaw`DELETE FROM events WHERE id = ${ack.eventId}::uuid`;
    return `deleted acknowledged event ${ack.eventId}`;
  }

  // A delivery to the endpoint that always answers 500 is marked succeeded, a false claim.
  const id = endpointIds["b-always-500"];
  if (!id) throw new Error("no always-500 endpoint");
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE deliveries SET status = 'succeeded', completed_at = now(),
      locked_by = NULL, locked_until = NULL, claim_token = NULL
    WHERE id = (SELECT id FROM deliveries WHERE endpoint_id = ${id}::uuid LIMIT 1)
    RETURNING id::text`;
  const row = rows[0];
  if (!row) throw new Error("no delivery to that endpoint yet");
  return `marked delivery ${row.id} succeeded, on an endpoint that only ever answers 500`;
}
