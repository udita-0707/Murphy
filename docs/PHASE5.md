# Murphy: Phase 5 brief (dashboard and demo experience, full scope)

Phase 4 is reviewed, approved and pushed. This file is the source of truth for Phase 5: scope, order, rules and the definition of done.

## How we work (same rules as before)

- Plan Mode first. Show the plan and wait for my approval before building.
- One local commit per step with a conventional message. Do not push.
- Tests with every feature. An ADR for each major decision.
- Typecheck, lint and the uncached test suite must be green. Write a handover doc with verify commands at the end.
- Check free disk before long runs (my disk filled up once).

## Calendar

The hackathon is on 12 Nov 2026.

- Demo path (items a to e) functionally finished by the night of 8 Nov.
- Everything else (items f to i) by the night of 10 Nov.
- 11 Nov is a freeze: rehearsal and bug fixes only.

I want ALL items below built, in the order given. Never let a later item break an earlier one. If something truly cannot be done in time, tell me why and what you suggest. Do not drop anything silently.

## Read first

Read `docs/handover/phase-4.md` and `docs/run-report-schema.md`. The dashboard reads the existing API and the versioned run report. Do not change the delivery path.

## Design (do this before writing any UI)

Use two skills with a clear split:

1. **Hallmark is primary.** Follow its flow: ask me about audience, use and tone first (I will answer), then propose the macrostructure and theme, then write a design direction note. Hallmark owns the theme, the structure, the tokens (`tokens.css`) and the hero screen. Run its slop test on the hero screen before showing it to me.
2. **design-taste-frontend (Taste Skill) is secondary.** Use it only AFTER I approve the Hallmark direction, and only for polish: micro-interactions, motion, spacing and detail on the hero and split-screen. If the two skills conflict, Hallmark wins. Ignore Taste rules that only make sense for marketing sites (real photographs, one section per screen, landing page sections), because this is an app.

Do NOT use artifact-design or generic frontend output.

Design requirements:

- Murphy is a chaos-testing tool for webhooks with a "Murphy's law" personality, built for developers. It will be shown on a projector in a hackathon demo, so it must be striking, high contrast and readable from the back of a room.
- Build a small design system: tokens, and components (status badges, timeline rows, assertion cards, fault chips labelled Engine or Target, code and JSON blocks), plus consistent loading, empty and error states.
- FAIL, PASS and errored must never rely on colour alone. Shape and wording must differ too. Support reduced motion, keyboard focus and sufficient contrast.
- Avoid generic template looks. Make the hero screen memorable.
- Show me the design direction (palette, typography, spacing, motion, how FAIL, PASS and errored look) and wait for my approval together with the plan.

Skill guardrails for this run: do not run imagegen or any image generation, do not install hooks (no `install.mjs` or `install-hook.mjs`), do not edit `settings.json`, do not install anything from either skill's scripts, and make no network calls from skill scripts. You may run Hallmark's sloplint on my own code, and any browser render check against localhost only. The dashboard needs no photos or generated images. Keep the Hallmark project memory file (`.hallmark/log.json`) in the repo.

## Stack

Next.js (App Router) in `apps/dashboard`, with Tailwind. Apply the skills' rules and tokens inside React components, not as standalone HTML pages (the standalone HTML report export in item e is the exception and must use the same tokens). Reuse shared code with the CLI for starting runs (endpoint creation, state_url handling). Do not duplicate that logic.

## Scope, in this order

**a. Login.** Paste an API key, kept in sessionStorage and sent as a bearer token to the API.

**b. Scenario list and Run.** List scenarios (built-ins and project ones) with provider, difficulty, the faults used, and which faults need target cooperation. A Run button starts a run against the demo target (naive or idempotent).

**c. Run view.** Live while running (poll every second), then the final report: the step timeline in real attempt order, faults labelled Engine or Target with their evidence, assertions with readable reasons, final state expected vs reported, and the limits section. `errored` must look clearly different from `failed`, in colour and in wording: "not a fair test, proves nothing".

**d. Split-screen hero.** "Run on both handlers" starts the same scenario on naive and idempotent at the SAME time and shows them side by side with aligned timelines: FAIL on the naive side, PASS on the idempotent side, with the diverging effect highlighted (for example "Booking effect: 2 vs 1"). In the plan, tell me how the two sides stay in sync and what happens if one finishes early or errors.

**e. Standalone HTML export.** One self-contained HTML file (inline CSS, no external requests) for a single run report, and one for the split-screen comparison, using the same design.

**f. Delivery log.** Endpoints list with status, events list, delivery detail with attempts, the DLQ with replay buttons, and a filter to hide simulated traffic.

**g. GitHub login (OAuth)** alongside the API key login: sign in with GitHub, map the user to a project (create one on first login), and handle sessions safely (httpOnly cookie, CSRF protection, state parameter). Propose the minimal secure design in the plan, including what I must set up on GitHub (OAuth app, callback URLs for localhost and for a hosted URL) and what it needs from the API side. API key login must keep working.

**h. Chaos panel for the live demo (local mode only).** Buttons to kill a worker, restart Postgres, and make the demo target answer 500 for N seconds, with a live view of deliveries and attempts recovering and a counter proving no accepted event was lost. It must refuse to run unless `MURPHY_MODE=local` and the database is on localhost, like `demo:reset`. Explain in the plan how the dashboard controls processes safely (a small local-only control service is fine, never part of the hosted deployment).

**i. Hosted deployment.** Deploy the API, worker, dashboard, Postgres and a public demo target so the whole demo works from a public URL. First give me the plan with the honest cost, the risks and the fastest platform choice. Hosted mode refuses localhost targets, so the demo target needs a public https URL, and GitHub OAuth needs the hosted callback. Build it only after I approve that plan, and keep the local demo working as the primary fallback.

## Tests

- Component tests for report rendering (passed, failed and errored fixtures, and both exports).
- One end-to-end test that runs the split-screen flow against the real API, worker and demo target.
- Tests for the GitHub login flow with a mocked GitHub.
- Tests that the chaos panel refuses to run outside local mode.

## Definition of done

I open the dashboard, sign in, click "Run on both handlers" on a booking scenario, and watch one side FAIL and the other PASS with a readable aligned timeline. I download the comparison as one HTML file, trigger a chaos event and watch deliveries recover, and the same thing works from a public URL.

## Hard rules

- Local mode only for anything that targets localhost.
- Tenant isolation unchanged.
- No secrets in the browser beyond the API key I pasted or the session cookie.
- No Redis.
- No changes to the delivery path.

## Start by showing me

1. The design direction.
2. The Phase 5 plan.
3. How the split screen stays in sync.
4. The risks.
5. The hosted deployment plan for item i.
