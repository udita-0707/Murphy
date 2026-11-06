import { faultName, faultOrigin } from "@/lib/faults";
import { FaultGlyph } from "./elements";

/** Engine faults come from Murphy's real worker alone. Target faults need the target's cooperation. */
export function FaultChip({ kind }: { kind: string }) {
  const origin = faultOrigin(kind);
  return (
    <span className={`chip chip--${origin}`}>
      <FaultGlyph kind={kind} />
      {origin === "engine" ? "Engine" : "Target"}: {faultName(kind)}
    </span>
  );
}
