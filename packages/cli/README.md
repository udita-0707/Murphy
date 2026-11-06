# @murphy/cli

Runs a scenario against a handler and prints a live timeline and the result. It talks to the API over
HTTP, so the real worker does all the delivering.

```sh
pnpm dev                 # terminal 1: API and worker
pnpm demo:target         # terminal 2: the demo target
export MURPHY_API_KEY=mk_...

pnpm -s murphy run packages/simulator/scenarios/booking-duplicate-confirmation.yaml --target naive
```

`-s` keeps pnpm's own output out of the way, including its error line after a failed run.

Exit codes: 0 passed, 1 failed, 2 errored (the run proves nothing), 3 usage or setup problem.

To test your own handler, see `packages/sdk/README.md`.
