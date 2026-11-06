import { credit, type ProviderProfile } from "../model.js";

const COLLECT_WINDOW_SECONDS = 15 * 60;

/**
 * UPI collect requests. The shape is generic, not any one aggregator's.
 *
 *   created -> initiated -> pending -> success
 *                  \           \-> failed
 *                   \-> failed  \-> expired -> success
 *
 * `expired -> success` is a late bank confirmation: the collect window closed, then the bank
 * reported the debit went through. It is legal because it happens, and handlers that treat expired
 * as final lose money when it does.
 */
export const upi: ProviderProfile = {
  name: "upi",
  label: "UPI collect style",
  entityKind: "upi_collect",
  currencies: ["INR"],
  initialState: "created",
  transitions: {
    "upi.collect.initiated": {
      from: ["created"],
      apply: (l) => ({ ...l, state: "initiated" }),
    },
    "upi.collect.pending": {
      from: ["initiated"],
      apply: (l) => ({ ...l, state: "pending" }),
    },
    "upi.collect.success": {
      from: ["pending", "expired"],
      apply: (l) => credit(l, "success"),
    },
    "upi.collect.failed": {
      from: ["initiated", "pending"],
      apply: (l) => ({ ...l, state: "failed" }),
    },
    "upi.collect.expired": {
      from: ["pending"],
      apply: (l) => ({ ...l, state: "expired" }),
    },
  },
  makeIds: (rng) => ({
    id: rng.id("col"),
    txn_id: `UPI${rng.digits(16)}`,
    merchant_ref: rng.id("ref", 10),
    rrn: rng.digits(12),
    payer_vpa: `payer${rng.digits(4)}@examplebank`,
  }),
  buildPayload({ type, ledger, ids, currency, createdAt }) {
    const success = ledger.state === "success";
    return {
      event_type: type,
      occurred_at: new Date(createdAt * 1000).toISOString(),
      collect: {
        id: ids.id!,
        txn_id: ids.txn_id!,
        merchant_ref: ids.merchant_ref!,
        status: ledger.state,
        amount: { value_minor: ledger.amountMinor, currency },
        payer_vpa: ids.payer_vpa!,
        payee_vpa: "merchant@examplebank",
        rrn: success ? ids.rrn! : null,
        expires_at: new Date((createdAt + COLLECT_WINDOW_SECONDS) * 1000).toISOString(),
        failure_reason: ledger.state === "failed" ? "PAYER_DECLINED" : null,
      },
    };
  },
};
