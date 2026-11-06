# Run report and target contract

Three contracts around a simulator run. The code that enforces them is in `packages/simulator/src/report.ts` and
`packages/core/src/murphy-block.ts`.

## Run report, schema version 1

Stored in `scenario_runs.report`. Read it with `GET /v1/runs/:id/report`, or add `?format=md` for the markdown version. Until
the run finishes, that route answers `409 report_not_ready`.

**Versioning.** Changing a field's meaning or removing one needs a new `schema_version`. Adding an optional field does not.
Readers should ignore fields they do not know. Reports are checked against `runReportSchema` before being stored.

Reports never contain request headers, signatures or secrets.

### Verdicts

| `run.status` | Means                                                                                             | What to do               |
| ------------ | ------------------------------------------------------------------------------------------------- | ------------------------ |
| `passed`     | Every assertion held, and every planned fault really happened                                     | Nothing                  |
| `failed`     | At least one assertion did not hold. A fair test found a problem                                  | Fix the handler          |
| `errored`    | The run was not a fair test, so **it proves nothing**, in either direction. `run.reason` says why | Fix the setup, run again |

A run is `errored` if a delivery never got through, the run passed its deadline, the target's state could not be read, or a planned
fault did not happen. Show `errored` differently from `failed`.

### Fields

| Field                                   | Type                          | Meaning                                                                                                 |
| --------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `schema_version`                        | `1`                           |                                                                                                         |
| `run.id`                                | string                        |                                                                                                         |
| `run.status`                            | `passed`, `failed`, `errored` |                                                                                                         |
| `run.reason`                            | string or null                | Why it failed or errored. Null when passed                                                              |
| `run.seed`                              | integer                       | Same seed, same payloads                                                                                |
| `run.started_at`, `run.finished_at`     | ISO 8601                      |                                                                                                         |
| `run.duration_ms`                       | integer                       |                                                                                                         |
| `scenario.slug`, `.name`, `.difficulty` | string                        |                                                                                                         |
| `scenario.provider`                     | string                        | `payments`, `upi` or `booking`                                                                          |
| `scenario.provider_label`               | string                        | What payloads resemble, such as "Razorpay-style". Show this one, because payloads are not exact copies  |
| `target.handler`                        | string or null                | A readable name for what was tested, such as `naive`                                                    |
| `target.endpoint_id`                    | string                        |                                                                                                         |
| `summary.*`                             | integers                      | `assertions_passed`, `assertions_failed`, `faults_planned`, `faults_realised`, `deliveries`, `attempts` |
| `assertions[]`                          | array                         | See below                                                                                               |
| `faults[]`                              | array                         | See below                                                                                               |
| `steps[]`                               | array                         | One per step, in the provider's **logical** order                                                       |
| `timeline[]`                            | array                         | Every attempt, in the order it **really** started. Comparing this with `steps` shows a reorder          |
| `entities[]`                            | array                         | Expected and reported final state                                                                       |
| `limits[]`                              | strings                       | What this run does not prove. Show them                                                                 |

**`assertions[]`:** `kind`, `entity`, `status` (`pass`, `fail`, `not_evaluated`), `reason` (readable, always present). `not_evaluated`
appears only on an errored run.

Kinds: `no_double_credit`, `no_double_booking`, `final_state`, `ordering_tolerated`, `exactly_once_effect`.

**`faults[]`:** `step`, `kind`, `realised_by`, `detail`, `realised` (boolean), `evidence` (readable, from the attempt log).

| `kind`                | `realised_by` | Means                                                           |
| --------------------- | ------------- | --------------------------------------------------------------- |
| `delay`               | `engine`      | Sent later than planned                                         |
| `reorder`             | `engine`      | Sent before a step that logically comes first                   |
| `duplicate`           | `engine`      | A second delivery with the same `webhook-id`                    |
| `drop_then_redeliver` | `target`      | The first attempt was answered 503, and the worker retried      |
| `respond_with`        | `target`      | The target answered the listed statuses, and the worker retried |

`engine` faults came from Murphy's real delivery worker alone. `target` faults happened only because the target obeyed the `_murphy`
block. Say which is which when showing them.

**`steps[]`:** `id`, `index`, `event_type`, `entity`, `provider_entity_id`, `event_id`, `webhook_id`, `planned_offsets_ms`, `fault_kinds`,
`deliveries[]` (`delivery_id`, `status`, `attempts[]`).

**`attempts[]`:** `attempt_no`, `started_at`, `at_ms` (since the run started), `duration_ms`, `status` (null if there was no HTTP response),
`error`.

**`timeline[]`:** `at_ms`, `step`, `event_type`, `delivery_id`, `attempt_no`, `status`, `error`.

**`entities[]`:** `id` (the scenario's name), `kind`, `provider_id`, `expected`, `actual` (null if the target reported nothing). Each of
`expected` and `actual` has `state`, `balance_minor` and `effects` (`credit`, `booking`, `refund`, `hold`).

## The `_murphy` block

One top-level key in the body of every simulated event, and only simulated events. It is inside the signed body, so it cannot be
forged without the endpoint's secret.

```json
{
  "...": "the provider-shaped payload",
  "_murphy": {
    "simulated": true,
    "version": 1,
    "run_id": "6e0f0c1c-...",
    "scenario": "booking-cancel-after-payment",
    "step": "refunded",
    "event": "refund.processed",
    "entity_id": "res_zjFvmGHgKPfouc",
    "forced_responses": [{ "status": 503, "run_handler": true }]
  }
}
```

`forced_responses` is optional. Its first entry applies to the first arrival of this `webhook-id`, and so on. Later arrivals are normal.
With `run_handler: true`, the handler runs and the reply is replaced anyway, as if it was lost on the way back. With `false`, the handler
does not run. `delay`, `reorder` and `duplicate` never appear here, because the target has no part in them.

Simulated events are also marked by `events.scenario_run_id` in the database, and by `simulated` and `scenario_run_id` in `GET /v1/events/:id`.

## The target's state endpoint

`GET {state_url}?run_id=<id>` answers 200 with:

```json
{
  "entities": {
    "<_murphy.entity_id>": {
      "state": "confirmed",
      "effects": { "credit": 0, "booking": 1, "refund": 0, "hold": 0 },
      "balance_minor": 0
    }
  }
}
```

Missing `effects` and `balance_minor` count as zero, and unknown fields are ignored. Effects are **net outcomes**, not counts of events seen:
`booking` is reservations held now, so a confirm followed by a cancel gives 0, in either arrival order. `credit` is times money was credited,
`refund` is distinct refunds applied, and `hold` is authorisation holds open now.

The worker reads this through the SSRF guard, with no redirects, a 5 s limit and a 256 KB limit. `murphyTarget()` in `@murphy/sdk` implements
this and the block above. See `packages/sdk/README.md`.
