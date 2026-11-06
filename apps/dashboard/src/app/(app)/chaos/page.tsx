import { ChaosPanel } from "@/components/chaos-panel";
import { Empty } from "@/components/states";
import { chaosGuard } from "@/lib/chaos-server";

export const dynamic = "force-dynamic";

export default function Chaos() {
  const guard = chaosGuard();
  if (guard.ok) return <ChaosPanel />;
  return (
    <section className="section">
      <h1 className="section__head">Chaos panel: local only</h1>
      <Empty title="This one cannot run here.">
        <p>
          It kills workers and restarts Postgres, so it refuses to run anywhere but a local machine
          with a local database. Everything else works from here.
        </p>
        <p className="board__meta">Why it refused: {guard.reason}.</p>
      </Empty>
    </section>
  );
}
