# ADR 013: The dashboard is a same-origin proxy, and comparisons have no table

- Status: Accepted
- Date: 2026-11-07

## Context

The dashboard needs to call the API, start two runs together, and later hold a GitHub session in a cookie. The API has no CORS,
and the demo target's `POST /_secrets` cannot be called from a browser. The split screen also has to survive a refresh.

## Decision

**The dashboard's server forwards `/api/v1/*` to the API.** The browser only ever talks to its own origin. The proxy adds no
business logic, and tenant isolation stays in the API. An API key stays in sessionStorage and is forwarded as a bearer token.

**Starting runs is shared code.** `packages/client` holds the API client and the demo target preparation, and the CLI and the
dashboard's server both use it.

**A comparison is a URL**, `/compare?naive=<id>&idempotent=<id>`. There is no comparison table. The API's tenant checks apply to
each run id, and a refresh resumes.

**Sides are aligned on what happened, not on the clock.** Rows match on step, copy number and attempt number. Both runs get the
same seed, each `at_ms` is relative to its own run, and the screen shows the real gap between the two starts. A row found on only
one side stays visible, with an explicit blank opposite it.

**An errored side means no comparison.** The diverging figure is replaced with a statement that the run proves nothing.

## Consequences

- No CORS configuration, and no API URL or secret reaches the browser.
- The API gains no comparison concept, so the delivery path and the run report are unaffected.
- There is no cancel. If only one of the two runs starts, it is left to finish, and no comparison is shown.
- A tab closed mid-run leaves a throwaway endpoint behind. The simulated filter hides it. This is an accepted limit for now.
