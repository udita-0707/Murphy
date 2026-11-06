<!-- A real report from `pnpm -s murphy run packages/simulator/scenarios/booking-duplicate-confirmation.yaml --target naive --report ...`. -->

# FAILED: Duplicate confirmation webhook causes a double booking

**2 of 3 assertions failed. Holds 2 bookings, expected 1: one reservation took more than it should.**

|          |                                                                |
| -------- | -------------------------------------------------------------- |
| Handler  | naive                                                          |
| Scenario | `booking-duplicate-confirmation` (beginner)                    |
| Provider | Booking platform style                                         |
| Seed     | 4242                                                           |
| Run      | `d7b3edb7-47f0-4a37-b76a-28fcad260f5b`                         |
| Duration | 4.8 s                                                          |
| Traffic  | 3 deliveries, 3 attempts, all sent by the real delivery worker |

## Assertions

| Result | Assertion           | Entity | Why                                                                    |
| ------ | ------------------- | ------ | ---------------------------------------------------------------------- |
| FAIL   | no_double_booking   | stay   | Holds 2 bookings, expected 1: one reservation took more than it should |
| PASS   | final_state         | stay   | Ended in "confirmed"                                                   |
| FAIL   | exactly_once_effect | stay   | Booking effect is 2, expected 1                                        |

## Faults injected

**Engine** faults came from Murphy's real delivery worker alone. **Target** faults only happen because the target cooperated by obeying the signed `_murphy` block.

| Step      | Fault     | Realised by | What it does                                       | Happened? | Evidence                                        |
| --------- | --------- | ----------- | -------------------------------------------------- | --------- | ----------------------------------------------- |
| confirmed | duplicate | Engine      | Sent again 1500 ms later, with the same webhook-id | Yes       | 2 deliveries with the same webhook-id got a 2xx |

## Timeline

Every attempt, in the order it really started.

| At     | Step      | Event                 | Attempt | Result |
| ------ | --------- | --------------------- | ------- | ------ |
| 1.31 s | created   | reservation.created   | 1       | 200    |
| 2.87 s | confirmed | reservation.confirmed | 1       | 200    |
| 4.40 s | confirmed | reservation.confirmed | 1       | 200    |

## Final state

| Entity | Provider id          |                    | State     | Balance | Credit | Booking | Refund | Hold |
| ------ | -------------------- | ------------------ | --------- | ------- | ------ | ------- | ------ | ---- |
| stay   | `res_zjFvmGHgKPfouc` | expected           | confirmed | 0       | 0      | 1       | 0      | 0    |
| stay   | `res_zjFvmGHgKPfouc` | reported by target | confirmed | 0       | 0      | 2       | 0      | 0    |

## What this does not prove

- Payloads resemble the named provider's shape. They are not exact copies, so a handler can pass here and still meet a field it does not expect in production.
- The target's final state is what the target itself reported. Murphy cannot see inside it, so a wrong state endpoint gives a wrong result.
- A pass means this handler survived these faults, in this run. It does not prove the handler is correct for others, or under concurrent delivery on several servers.
