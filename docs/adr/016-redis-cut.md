# ADR 016: Redis is cut

- Status: Accepted
- Date: 2026-11-07

## Context

Redis has been started by compose since phase 1, with no code using it. It would only ever have held rate limits and fairness counters, never the source of
truth, and the final decision was left for phase 5. The phase 5 brief says no Redis.

## Decision

Remove it from compose, the environment example and the docs. Postgres stays the only store.

## Consequences

- One less thing to run, and to pay for when hosted.
- Fairness stays in the claim query (ADR 004). There is no rate limiting by Redis. If that is needed later, this is the decision to revisit.
- A `redis` container from an earlier `pnpm infra:up` stays behind until `pnpm demo:reset` or `docker compose ... down --remove-orphans`. It does nothing.
- Older handover notes and ADRs still mention Redis. They describe what was true then, and are not rewritten.
