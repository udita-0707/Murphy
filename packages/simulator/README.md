# @murphy/simulator

Murphy's event simulator. This package is pure: no database and no network.

- `src/providers`: the `payments` (Razorpay-style), `upi` and `booking` profiles. Each is a state
  machine table and a payload builder. Payloads are "-style" shapes, not exact copies of any provider.
- `src/simulate.ts`: turns entities and a logical sequence of events into payloads and the expected
  final state. An illegal sequence is an error. The same seed gives the same payloads.
