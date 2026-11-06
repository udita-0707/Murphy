import { credit, refund, type JsonObject, type ProviderProfile } from "../model.js";

/**
 * Hotel or travel reservations. The shape is generic, not any one platform's.
 *
 *   none -> created -> confirmed -> paid
 *              \           \         \
 *               \-----------\---------\-> cancelled
 *
 * Refunds apply to a paid or cancelled reservation that has money left to return. A partial refund
 * keeps the state; returning everything moves it to refunded.
 */
export const booking: ProviderProfile = {
  name: "booking",
  label: "Booking platform style",
  entityKind: "reservation",
  currencies: ["INR", "USD", "EUR", "GBP", "SGD"],
  initialState: "none",
  transitions: {
    "reservation.created": {
      from: ["none"],
      apply: (l) => ({ ...l, state: "created" }),
    },
    "reservation.confirmed": {
      from: ["created"],
      apply: (l) => ({ ...l, state: "confirmed", effects: { ...l.effects, booking: 1 } }),
    },
    "payment.captured": {
      from: ["confirmed"],
      apply: (l) => credit(l, "paid"),
    },
    "reservation.cancelled": {
      from: ["created", "confirmed", "paid"],
      apply: (l) => ({ ...l, state: "cancelled", effects: { ...l.effects, booking: 0 } }),
    },
    "refund.processed": {
      from: ["paid", "cancelled"],
      guard: refund.guard,
      apply: refund.apply,
    },
  },
  makeIds: (rng) => ({
    id: rng.id("res"),
    property_id: rng.id("prop", 8),
    guest_ref: rng.id("guest", 8),
    payment_id: rng.id("pay"),
  }),
  buildPayload({ type, ledger, previous, ids, currency, createdAt, amountMinor, rng }) {
    const nights = 1 + (createdAt % 5);
    const data: JsonObject = {
      reservation: {
        id: ids.id!,
        property_id: ids.property_id!,
        guest_ref: ids.guest_ref!,
        status: ledger.state,
        check_in: new Date((createdAt + 7 * 86_400) * 1000).toISOString().slice(0, 10),
        nights,
        total_minor: ledger.amountMinor,
        paid_minor: ledger.capturedMinor,
        refunded_minor: ledger.refundedMinor,
        currency,
      },
    };
    if (type === "payment.captured") {
      data.payment = { id: ids.payment_id!, amount_minor: ledger.capturedMinor, currency };
    }
    if (type === "refund.processed") {
      data.refund = {
        id: rng.id("rfnd"),
        payment_id: ids.payment_id!,
        amount_minor: amountMinor ?? ledger.refundedMinor - previous.refundedMinor,
        currency,
      };
    }
    return { id: rng.id("evt"), type, created: createdAt, data };
  },
};
