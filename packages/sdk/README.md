# @murphy/sdk

Helpers for webhook receivers. `murphyTarget()` lets your own handler be tested by a Murphy scenario.

```ts
import express from "express";
import { murphyTarget } from "@murphy/sdk";

const bookings = new Map(); // your handler's own storage
const seen = new Set();

const app = express();
// Mount before express.json(): signatures cover the raw body.
app.use(
  "/webhooks/murphy",
  murphyTarget({
    secret: process.env.MURPHY_WEBHOOK_SECRET!,
    onEvent(event) {
      if (seen.has(event.webhookId)) return; // duplicates share a webhook-id
      seen.add(event.webhookId);
      // ...your real logic, then record the result under the entity's id...
      bookings.set(event.murphy!.entity_id, {
        state: "confirmed",
        effects: { booking: 1 },
        balance_minor: 0,
      });
    },
    state: () => ({ entities: Object.fromEntries(bookings) }),
  }),
);
app.listen(3001);
```

Then create an endpoint for it (keep the secret it returns) and run a scenario:

```sh
pnpm -s murphy run packages/simulator/scenarios/booking-duplicate-confirmation.yaml \
  --endpoint <endpoint id> --state-url http://127.0.0.1:3001/webhooks/murphy/state
```

## The contract

| Route                 | Does                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `POST /`              | Verifies the signature, obeys forced responses, calls `onEvent`. Answers 200 if it returns, 500 if it throws |
| `GET /state?run_id=…` | Returns `{ entities: { <entity_id>: { state, effects, balance_minor } } }`                                   |

- **`state`:** the entity's final state, in the provider's words, such as `confirmed` or `captured`.
- **`effects`:** what your handler ended up with, as net outcomes. `credit`: times money was credited. `booking`:
  reservations held now. `refund`: distinct refunds applied. `hold`: authorisation holds open now. Leave out any that do not apply.
- **`balance_minor`:** money held from this entity, in minor units (paise, cents).

**Faults.** Murphy does `delay`, `reorder` and `duplicate` on its own. `respond_with` and `drop_then_redeliver` need this
helper: it reads them from the signed `_murphy` block in the body. Without it, a scenario using them ends as `errored`, not passed.

`_murphy` is one top-level key, present only on simulated events. See `docs/run-report-schema.md`.

**Do not mount this in production.** `GET /state` has no authentication, and forced responses exist to make your handler see failures.
