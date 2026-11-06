import { credit, refund, type JsonObject, type ProviderProfile } from "../model.js";

/**
 * Razorpay-style card and UPI payments. The shape resembles Razorpay's webhooks but is not a copy
 * of them, and the ids are made up.
 *
 *   created -> authorized -> captured -> refunded
 *      \            \-> failed
 *       \-> failed
 */
export const payments: ProviderProfile = {
  name: "payments",
  label: "Razorpay-style",
  entityKind: "payment",
  currencies: ["INR", "USD", "EUR", "GBP", "SGD"],
  initialState: "created",
  transitions: {
    "payment.authorized": {
      from: ["created"],
      apply: (l) => ({ ...l, state: "authorized", effects: { ...l.effects, hold: 1 } }),
    },
    "payment.failed": {
      from: ["created", "authorized"],
      apply: (l) => ({ ...l, state: "failed", effects: { ...l.effects, hold: 0 } }),
    },
    "payment.captured": {
      from: ["authorized"],
      apply: (l) => {
        const next = credit(l, "captured");
        return { ...next, effects: { ...next.effects, hold: 0 } };
      },
    },
    "refund.processed": { from: ["captured"], guard: refund.guard, apply: refund.apply },
  },
  makeIds: (rng) => ({
    id: rng.id("pay"),
    order_id: rng.id("order"),
    account_id: rng.id("acc"),
    email: `customer.${rng.digits(4)}@example.com`,
  }),
  buildPayload({ type, ledger, ids, currency, createdAt, amountMinor, previous, rng }) {
    const failed = ledger.state === "failed";
    const payment: JsonObject = {
      id: ids.id!,
      entity: "payment",
      amount: ledger.amountMinor,
      currency,
      status: type === "refund.processed" ? "captured" : ledger.state,
      order_id: ids.order_id!,
      method: "upi",
      vpa: "customer@examplebank",
      email: ids.email!,
      captured: ledger.capturedMinor > 0,
      amount_refunded: ledger.refundedMinor,
      refund_status:
        ledger.refundedMinor === 0
          ? null
          : ledger.refundedMinor === ledger.capturedMinor
            ? "full"
            : "partial",
      error_code: failed ? "BAD_REQUEST_ERROR" : null,
      error_description: failed ? "Payment was declined by the bank" : null,
      created_at: createdAt,
    };
    const payload: JsonObject = { payment: { entity: payment } };
    if (type === "refund.processed") {
      payload.refund = {
        entity: {
          id: rng.id("rfnd"),
          entity: "refund",
          amount: amountMinor ?? ledger.refundedMinor - previous.refundedMinor,
          currency,
          payment_id: ids.id!,
          status: "processed",
          speed_processed: "normal",
          created_at: createdAt,
        },
      };
    }
    return {
      entity: "event",
      account_id: ids.account_id!,
      event: type,
      contains: type === "refund.processed" ? ["refund", "payment"] : ["payment"],
      payload,
      created_at: createdAt,
    };
  },
};
