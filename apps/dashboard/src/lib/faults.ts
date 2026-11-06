/** Which side realises a fault, from `docs/run-report-schema.md`. */
const ORIGIN: Record<string, "engine" | "target"> = {
  delay: "engine",
  reorder: "engine",
  duplicate: "engine",
  drop_then_redeliver: "target",
  respond_with: "target",
};

const NAMES: Record<string, string> = {
  delay: "delay",
  reorder: "reorder",
  duplicate: "duplicate",
  drop_then_redeliver: "drop, then redeliver",
  respond_with: "forced reply",
};

export function faultOrigin(kind: string): "engine" | "target" {
  return ORIGIN[kind] ?? "engine";
}

export function faultName(kind: string): string {
  return NAMES[kind] ?? kind;
}

const ASSERTIONS: Record<string, string> = {
  no_double_credit: "No double credit",
  no_double_booking: "No double booking",
  final_state: "Final state",
  ordering_tolerated: "Survives reordering",
  exactly_once_effect: "Effect applied exactly once",
};

export function assertionName(kind: string): string {
  return ASSERTIONS[kind] ?? kind;
}
