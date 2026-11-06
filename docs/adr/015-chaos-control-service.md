# ADR 015: A local-only control service for the chaos panel

- Status: Accepted
- Date: 2026-11-07

## Context

The chaos panel has buttons that kill a worker, restart Postgres and make the demo target fail. A web page cannot do that itself, and the code that can must never
run in a hosted deployment. The dashboard's public URL must not be able to reach it.

## Decision

**`tools/control` is a small service that is never in a hosted image.** `pnpm demo:stack` starts it with the API, target and dashboard. It owns two workers, because a
panel can only kill a process it started. Run `pnpm demo:stack` instead of `pnpm dev`.

**Refusals, in layers.** Each stands alone:

1. The service refuses to start unless `MURPHY_MODE=local` and `DATABASE_URL` is on this machine. It uses the same guard as `demo:reset`, now `checkLocalOnly` in `@murphy/core`.
2. The dashboard's route applies that guard itself, first, before anything else. The page says "local only" and draws no buttons.
3. The service binds to 127.0.0.1.
4. It refuses a wrong `Host` (DNS rebinding) and any `Origin` (a browser), even with the token.
5. It needs a token that is random per start, known only to it and the dashboard's server. The browser never sees it.

**Fixed actions only.** Nothing from a request becomes a command or a path. The only value accepted is a whole number of seconds, from 1 to 60. Commands run with `execFile`, with fixed arguments and no shell.

**The target's fail mode does not exist outside local mode.** `tools/demo-target` only mounts those routes when `MURPHY_MODE=local`. It stops by itself after at most 60 s, so it can never be left broken.
This is lower than the 120 s in the plan: the shortened retries add up to about 71 s, so a longer failure would create dead letters and muddy the demo.

**The counter is checked, not inferred.** Traffic is real: events accepted with a 202 by the real API and delivered by the real worker. Each accepted event is re-read from the API by id:

- `delivered`: a delivery succeeded
- `retrying`: a delivery is pending, in flight or failed and due again
- `dead`: in the dead-letter queue, and replayable
- `lost`: none of the above

A send the API refuses, usually while Postgres restarts, was never accepted, so it is counted apart and retried with the same idempotency key. The target's own count of distinct arrivals is shown as a second opinion.

**The panel reports processes as they are.** A worker's state comes from the process exiting, not from what was last asked of it. A worker that exits on its own shows as crashed and is not restarted, because a restart would hide a bug.

**The panel says what is staged.** Retries are shortened on this machine (`WORKER_RETRY_SCHEDULE_MS`, ADR 010), and the screen says so. A delivery in flight when its worker dies waits for its lease, about 21 s, and its row says so.

## Consequences

- On the public URL the chaos panel only explains itself. The chaos part of the demo runs locally. Udita decided this in the plan.
- Starting traffic hands the signed-in credential to the control service, in memory, so traffic shows in that project's log. This is acceptable because the service is local only.
- Traffic stops by itself after 5 minutes.
