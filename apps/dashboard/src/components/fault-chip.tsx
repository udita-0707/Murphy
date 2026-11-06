import { faultName, faultOrigin } from "@/lib/faults";

/** Engine faults come from Murphy's real worker alone. Target faults need the target's cooperation. */
export function FaultChip({ kind }: { kind: string }) {
  const origin = faultOrigin(kind);
  return (
    <span className={`chip chip--${origin}`}>
      {origin === "engine" ? "Engine" : "Target"}: {faultName(kind)}
    </span>
  );
}
