import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { KeycapWord, MarkCap } from "@/components/keycaps";
import {
  CopyKey,
  CopyLine,
  FaultKeyboard,
  HeroSim,
  type Recordings,
} from "@/components/landing-parts";
import { ThemeToggle } from "@/components/theme-toggle";
import { VerdictPlate } from "@/components/verdict";
import { SCENARIOS } from "@/lib/landing";
import type { RunReport } from "@/lib/types";
import duplicateIdempotent from "../../test/fixtures/duplicate-idempotent.json";
import duplicateNaive from "../../test/fixtures/duplicate-naive.json";
import forcedIdempotent from "../../test/fixtures/forced-idempotent.json";
import forcedNaive from "../../test/fixtures/forced-naive.json";
import lostIdempotent from "../../test/fixtures/lost-idempotent.json";
import lostNaive from "../../test/fixtures/lost-naive.json";
import reorderIdempotent from "../../test/fixtures/reorder-idempotent.json";
import reorderNaive from "../../test/fixtures/reorder-naive.json";
import retryIdempotent from "../../test/fixtures/retry-idempotent.json";
import retryNaive from "../../test/fixtures/retry-naive.json";
import "@/styles/landing.css";

export const metadata: Metadata = {
  title: "Murphy: rehearse your webhooks failing",
  description: "Murphy duplicates, delays and reorders webhooks, then shows what your handler did.",
};

const NAIVE_CODE = `app.post("/hook", (req, res) => {
  bookings += 1;
  res.sendStatus(200);
});`;

const IDEMPOTENT_CODE = `app.post("/hook", (req, res) => {
  if (seen.has(req.get("webhook-id"))) {
    return res.sendStatus(200);
  }
  seen.add(req.get("webhook-id"));
  bookings += 1;
  res.sendStatus(200);
});`;

/** Real recorded runs (`scripts/make-fixtures.ts`), one for each fault key. */
const pair = (naive: unknown, idempotent: unknown) => ({
  naive: naive as RunReport,
  idempotent: idempotent as RunReport,
});
const RECORDINGS: Recordings = {
  duplicate: pair(duplicateNaive, duplicateIdempotent),
  reorder: pair(reorderNaive, reorderIdempotent),
  delay: pair(retryNaive, retryIdempotent),
  drop_then_redeliver: pair(lostNaive, lostIdempotent),
  respond_with: pair(forcedNaive, forcedIdempotent),
};

const DEDUPE_CODE = `app.post("/webhooks", async (req, res) => {
  await db.transaction(async (tx) => {
    const { rowCount } = await tx.query(
      \`INSERT INTO processed_webhooks (webhook_id)
       VALUES ($1) ON CONFLICT DO NOTHING\`,
      [req.get("webhook-id")],
    );
    if (rowCount === 0) return; // Seen it. Do nothing, say 200.
    await applyBooking(tx, req.body);
  });
  res.sendStatus(200);
});`;

const STEPS = [
  { title: "Pick a fault", line: "Duplicate, reorder, delay, or a lost reply." },
  { title: "Press run", line: "The real worker delivers it to both handlers." },
  { title: "Compare handlers", line: "Same events. See which one held." },
];

export default async function Landing() {
  const theme = (await cookies()).get("murphy-theme")?.value === "platform" ? "platform" : "night";
  return (
    <div className="landing">
      <header className="slab">
        <div className="container slab__inner">
          <Link href="/" className="topbar__mark">
            <MarkCap />
            Murphy
          </Link>
          <nav className="slab__nav" aria-label="Page">
            <a className="topbar__link" href="#faults">
              Faults
            </a>
            <a className="topbar__link" href="#verdicts">
              Verdicts
            </a>
            <a className="topbar__link" href="#start">
              Start
            </a>
          </nav>
          <div className="topbar__actions">
            <ThemeToggle initial={theme} />
            <Link className="btn btn--small" href="/login">
              Sign in
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className="container hero">
          <div className="hero__text">
            <h1 className="hero__head">Your webhooks will fail. Rehearse it.</h1>
            <p className="hero__line">
              Murphy duplicates, delays and reorders webhooks, then shows what your handler did.
            </p>
            <div className="hero__actions">
              <Link className="btn btn--primary btn--big" href="/login">
                Open the dashboard
              </Link>
              <a className="btn btn--big" href="#faults">
                See the faults
              </a>
            </div>
            <ol className="howto">
              {STEPS.map((step, i) => (
                <li className="howto__step" key={step.title}>
                  <span className="cap howto__cap" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span>
                    <span className="howto__title">{step.title}</span>
                    <span className="howto__line">{step.line}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <HeroSim recordings={RECORDINGS} />
        </section>

        <section className="container stats" aria-label="Measured results">
          <div className="stat">
            <p className="stat__figure">40/40</p>
            <p className="stat__label">Side-by-side runs split as expected, at real speed</p>
          </div>
          <div className="stat">
            <p className="stat__figure">58/58</p>
            <p className="stat__label">
              Events delivered through a killed worker, a failing target and a Postgres restart
            </p>
          </div>
          <div className="stat">
            <p className="stat__figure">3,000</p>
            <p className="stat__label">Events through the chaos harness, with none lost</p>
          </div>
          <p className="stats__note">
            Our own runs, on one laptop, against handlers we wrote. They show the checks work, not
            that your app is safe.
          </p>
        </section>

        <section className="container band" id="faults">
          <h2 className="band__head">Press a fault.</h2>
          <FaultKeyboard />
        </section>

        <section className="container band">
          <h2 className="band__head">Same events. Two handlers.</h2>
          <div className="duel">
            <div className="duel__side">
              <VerdictPlate status="failed" reason="Holds 2 bookings, expected 1" />
              <pre className="code" aria-label="A naive handler, simplified" tabIndex={0}>
                <code>{NAIVE_CODE}</code>
              </pre>
            </div>
            <div className="duel__side">
              <VerdictPlate status="passed" reason={null} />
              <pre className="code" aria-label="An idempotent handler, simplified" tabIndex={0}>
                <code>{IDEMPOTENT_CODE}</code>
              </pre>
            </div>
          </div>
        </section>

        <section className="container band" id="fix">
          <div className="fix">
            <div className="fix__text">
              <h2 className="band__head">Fix it.</h2>
              <p className="fix__line">
                Remember each webhook-id in the same transaction as the effect. Then a second
                delivery changes nothing.
              </p>
              <CopyKey text={DEDUPE_CODE} label="Copy the code" />
            </div>
            <pre className="code" aria-label="Webhook-id dedupe" tabIndex={0}>
              <code>{DEDUPE_CODE}</code>
            </pre>
          </div>
        </section>

        <section className="container band" id="verdicts">
          <h2 className="band__head">Three verdicts. One of them is honest about itself.</h2>
          <div className="verdicts">
            <div className="verdicts__item">
              <VerdictPlate status="failed" reason="A fair test found a problem." />
            </div>
            <div className="verdicts__item">
              <VerdictPlate status="passed" reason={null} />
            </div>
            <div className="verdicts__item">
              <VerdictPlate
                status="errored"
                reason="A planned fault did not happen. Run it again."
              />
            </div>
          </div>
        </section>

        <section className="container band">
          <h2 className="band__head">Eight ways to find out.</h2>
          <ul className="library">
            {SCENARIOS.map((scenario) => (
              <li className="library__item" key={scenario.name}>
                <span className="library__name">{scenario.name}</span>
                <span className="badge badge--muted">{scenario.provider}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="container band" id="start">
          <h2 className="band__head">Start it on your machine.</h2>
          <div className="start">
            <div className="start__steps">
              <p className="start__needs">
                Needs Node 20, pnpm and Docker. Your API key is printed by the reset, once.
              </p>
              <CopyLine command="pnpm install" />
              <CopyLine command="pnpm demo:reset" />
              <CopyLine command="pnpm demo:stack" />
            </div>
            <div className="start__action">
              <p className="start__line">Paste the key it prints, and break something.</p>
              <Link className="btn btn--primary btn--big" href="/login">
                Open the dashboard
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="mast">
        <div className="container">
          <KeycapWord size="lg" />
          <p className="mast__line">Anything that can go wrong will.</p>
        </div>
      </footer>
    </div>
  );
}
