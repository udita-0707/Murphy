/**
 * The signed `_murphy` block carried at the top level of every simulated event, and only simulated
 * events. It marks the event as simulated and tells a cooperating target which responses to force.
 * Faults Murphy can make on its own (delay, reorder, duplicate) are never listed here (ADR 011).
 */
export const MURPHY_BLOCK_KEY = "_murphy";

export interface MurphyForcedResponse {
  /** Status to answer with for this arrival. */
  status: number;
  /** True: run the handler, then answer with this status anyway (the reply was lost). */
  run_handler: boolean;
}

export interface MurphyBlock {
  simulated: true;
  version: 1;
  run_id: string;
  scenario: string;
  step: string;
  event: string;
  /** The provider's id for the entity, which keys it in the target's state. */
  entity_id: string;
  /** The first arrival of this webhook-id gets the first entry, and so on. Later arrivals are normal. */
  forced_responses?: MurphyForcedResponse[];
}

/** Reads the block from a verified body. Returns null for an ordinary event or a malformed block. */
export function readMurphyBlock(body: unknown): MurphyBlock | null {
  if (typeof body !== "object" || body === null) return null;
  const block = (body as Record<string, unknown>)[MURPHY_BLOCK_KEY];
  if (typeof block !== "object" || block === null) return null;
  const b = block as Record<string, unknown>;
  const strings = [b.run_id, b.scenario, b.step, b.event, b.entity_id];
  if (b.simulated !== true || b.version !== 1 || strings.some((s) => typeof s !== "string")) {
    return null;
  }
  if (b.forced_responses !== undefined) {
    if (!Array.isArray(b.forced_responses)) return null;
    for (const entry of b.forced_responses as unknown[]) {
      const e = entry as { status?: unknown; run_handler?: unknown } | null;
      if (typeof e?.status !== "number" || typeof e.run_handler !== "boolean") return null;
    }
  }
  return block as MurphyBlock;
}
