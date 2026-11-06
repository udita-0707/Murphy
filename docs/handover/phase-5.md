# Phase 5 handover: dashboard and demo experience

Date: 2026-11-07. Branch `main`, local commits only (not pushed). Author for every commit: `udita-0707`, no trailers.

## Outcome

**Items a to h are done, ahead of the calendar. Item i, the hosted deployment, is not started: it needs your go-ahead.** So the definition of done holds locally, and its
last clause, "the same thing works from a public URL", does not hold yet.

Nothing from the scope was cut. Two things changed from the plan, under "Changes from the plan".

## Results, on the final code

| Check                                                 | Result                                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Full suite, uncached                                  | **997 tests passed**, 15 of 15 tasks, 2m47                                                                              |
| Typecheck, lint, format                               | Clean                                                                                                                   |
| Delivery path diff against `5e074b5`                  | **Empty.** `deliver.ts`, `worker.ts`, `policy.ts`, `reaper.ts`, `net/send.ts`, `queue.ts`                               |
| Simultaneous pairs, real speed, real processes        | **40 of 40 as expected**, 20 pairs each on the 2 demo scenarios. Start gap median 1 ms, largest 3 ms, slowest run 5.0 s |
| Chaos seed 2002                                       | PASS. 3,000 events, 6,196 deliveries (`.chaos/phase5/seed-2002`)                                                        |
| Real `pnpm demo:stack`, every chaos button, in Chrome | **58 of 58 accepted events delivered, 0 lost**, then FAIL vs PASS with "2 vs 1" on the same stack                       |
| Hallmark sloplint                                     | 0 FAIL on the hero's 5 states, 2 report pages, sign-in and both exports                                                 |

Test counts: worker 275, dashboard 177, api 126, simulator 106, core 105, chaos 63, cli 35, control 35, demo-target 24, client 22, sdk 13, dev-receiver 10, demo-reset 6.

## Design

The first direction (Wayfind, a departure board in mono type) did not work for you, so it was replaced, by your brief: **cheerful, tactile, with buttons that press like keys**. It is now Hallmark's Squeeze theme, on a blue ground, with keycaps. Only the visual layer changed: features, logic and tests carried over. See `docs/design/direction.md`.

A landing page followed at `/`, and sign-in moved to `/login`. You asked to focus on the frontend and not spend time passing tests, so **the full suite and the browser end-to-end test have not been run since that change**. Run them before the 11 Nov freeze.

## By item

| Item | What exists                                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| a    | API key sign-in, kept in sessionStorage, checked against the API. Strict CSP with a per-request nonce                               |
| b    | Scenario list with provider, difficulty, faults and which need cooperation. Run on one handler or both                              |
| c    | Run view, live every second, then the report. Errored reads "Not a fair test, proves nothing", and is drawn differently             |
| d    | Split screen with aligned rows and a figure computed from the two reports. Sync rules are in ADR 013                                |
| e    | One HTML file for a report and for a comparison. Each carries a CSP that blocks all requests. Same tokens and components as the app |
| f    | Endpoints, events, event and delivery detail with attempts, DLQ with replay, a filter that hides simulated traffic, kept in the URL |
| g    | GitHub login next to API keys: httpOnly cookie, CSRF, `state`, PKCE, hosted allowlist. ADR 014                                      |
| h    | Chaos panel on a local-only control service, `pnpm demo:stack`. ADR 015                                                             |
| i    | **Not started.** See "Your decision"                                                                                                |

New ADRs: 013 proxy and stateless comparisons, 014 GitHub login, 015 control service, 016 Redis cut. New migration: `20261107120000_github_sessions`.

## What real runs caught

Fixtures and mocks passed all of these. They only showed up when real processes ran, which is why you should rehearse on the real stack.

- **A row stayed on "due" after it was sent.** Duplicate React keys in a row. Only visible on a live board.
- **The panel's workers crashed on start**, because the lease equalled the limit and must exceed it. Tests stayed green, since the test stack had a healthy worker of its own hiding it. That test now uses only the panel's workers, and fails if one exits unexpectedly.
- **The panel showed a crashed worker as running.** It now reads the state from the process, and shows a crash as a crash.
- **Status badges were stretched** by a CSS class name collision.
- **The dashboard was not loading the root `.env`.** Lint caught an unused import from a half-applied edit. The end-to-end test had hidden it by setting its variables directly.
- **A phase 4 test failed once I added a migration**, because it pins the newest one. I moved it to the new migration and added a proof for it, rather than loosening it.

## Changes from the plan

- **The target fails for at most 60 s, not 120 s.** The shortened retries add up to about 71 s, so a longer failure would create dead letters and muddy the demo.
- **The Taste skill was dropped**, as you asked. Polish followed Hallmark.

`pnpm test` now runs at most 5 packages at once. With the new suites, more than that overloaded Docker here (a load average of 17 on 8 cores, with your other containers running), and Postgres containers failed under it.

## How to verify

```sh
cd /Users/udita/Desktop/Murphy
pnpm install
pnpm typecheck && pnpm lint && pnpm format:check
pnpm exec turbo run test --force          # Docker must be running; about 3 minutes

git diff 5e074b5 HEAD -- apps/worker/src/deliver.ts apps/worker/src/worker.ts apps/worker/src/policy.ts \
  apps/worker/src/reaper.ts apps/worker/src/net/send.ts packages/db/src/queue.ts      # empty

# The definition of done, by hand. This wipes your local Murphy database.
pnpm demo:reset                           # prints a new key
pnpm demo:stack                           # about 30 s to build, then http://127.0.0.1:3100
```

Then, in the browser:

1. Paste the key, and choose **Run on both handlers** on the first scenario.
2. Watch FAIL and PASS land, with "Booking effect 2 vs 1". **Download comparison**, then open the file with your network off.
3. Go to **Chaos**, **Start traffic**, then **Kill a worker**, **Target answers 500** and **Restart Postgres**. **Stop traffic**, and wait for "All N accepted events delivered. None lost."

Other checks:

```sh
pnpm --filter @murphy/dashboard exec tsx scripts/pair-reliability.ts --pairs 20   # about 5 minutes
pnpm chaos --seed 2002 --out .chaos/phase5/seed-2002                              # engine regression
```

## What I ran, and what I did not

**Ran:** everything in the results table. `pnpm demo:stack` ran against a throwaway compose project (`murphy-verify`), so your local database was never touched, and I removed that project afterwards.

**Not run:**

- **`pnpm demo:reset` followed by `pnpm demo:stack` on your own database.** It wipes your data, so that is yours to run. Try it once before the demo.
- **Real GitHub.** Sign-in was tested in real Chrome against a mock GitHub server. It needs your OAuth App. PKCE support on GitHub is not confirmed by official documentation; if GitHub rejects it, tell me. `state` remains the required protection either way.
- **Anything hosted.** Hosted mode has still never reached a real public target.
- **A real projector.** Contrast ratios are computed from the colour values, not measured on a screen. Check it on 11 Nov, and use **Light room** if the room is bright.
- **Pair runs of the other 6 scenarios at real speed.** Only the 2 demo scenarios were repeated, and one pair each of the retry scenario. The scenario list marks which were repeated. Run others before relying on them.

**Weaker than Hallmark asks:**

- The render check cannot sign in, so signed-in pages (scenarios, log, chaos) had a source check and my own look at screenshots, with the API answered from fixtures in the browser, not the rendered gates.
- Hallmark's reviews ask for a fresh context. I reviewed the screens myself.

## For the demo

- **After Restart Postgres, wait about 2 seconds before moving to another page.** The first request afterwards can hit the dropped connection and show an error with **Try again**. The API then recovers by itself.
- **The Restart Postgres button can stay on "restarting" for up to about 25 s under traffic**, though the API was only away for about 2 s. That is `docker compose` reporting late.
- **A delivery in flight when its worker dies takes about 21 s to recover**, and its row says it is waiting for the lease. The other worker carries everything else meanwhile.
- **Word it carefully.** You wrote both handlers. The demo shows the checks can tell them apart, not that any real app is safe. The idempotent handler's dedupe is an in-memory set. The report's limits section says so, on screen.
- **Retries are shortened on the chaos stack**, and the panel says so. Say it first.
- **`pnpm -s murphy run` is still the fallback.** Nothing about it changed from the outside.

## Known limits

- A tab closed mid-run leaves its throwaway endpoint behind. The simulated filter hides it.
- There is no cancel. If only one of a pair starts, it finishes alone, and no comparison is shown.
- No limit on concurrent runs per project yet. The plan adds one for hosted, in item i.
- Starting traffic hands the signed-in credential to the local control service, in memory.
- `/preview/*` routes hold fixtures for design checks, and answer 404 in a production build.

## Your decision

**Item i needs your go-ahead.** The plan is section 5 of the approved plan: Railway, about $5 to $7 if kept for 1 to 2 weeks, about $14 for a full month. Those figures are my estimate, from rates found mostly on third-party sites, so check railway.com/pricing. It needs a card.

From you: a Railway account, a GitHub OAuth App, and `GITHUB_ALLOWED_LOGINS`.
