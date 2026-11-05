import type { PrismaClient } from "@prisma/client";

/**
 * Test and chaos instrumentation, never installed by migrations.
 *
 * Triggers record every change to a delivery row and every attempt insert, inside the writing
 * transaction. Invariants then run on that history, so a bad state that came and went is caught
 * even if the final state looks fine, and the record survives worker and Postgres crashes.
 */

const INSTALL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS delivery_audit (
     seq bigserial PRIMARY KEY,
     delivery_id uuid NOT NULL,
     old_status text NOT NULL,
     new_status text NOT NULL,
     old_attempt_count int NOT NULL,
     new_attempt_count int NOT NULL,
     old_client_error_count int NOT NULL,
     new_client_error_count int NOT NULL,
     old_reap_count int NOT NULL,
     new_reap_count int NOT NULL,
     old_locked_by text,
     new_locked_by text,
     new_locked_until timestamptz,
     old_claim_token uuid,
     new_claim_token uuid,
     endpoint_status text NOT NULL,
     endpoint_deleted boolean NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS attempt_audit (
     seq bigserial PRIMARY KEY,
     delivery_id uuid NOT NULL,
     attempt_no int NOT NULL
   )`,
  `CREATE OR REPLACE FUNCTION murphy_audit_delivery() RETURNS trigger AS $$
   DECLARE
     ep_status text;
     ep_deleted boolean;
   BEGIN
     SELECT e.status::text, e.deleted_at IS NOT NULL INTO ep_status, ep_deleted
     FROM endpoints e WHERE e.id = NEW.endpoint_id;
     INSERT INTO delivery_audit (
       delivery_id, old_status, new_status, old_attempt_count, new_attempt_count,
       old_client_error_count, new_client_error_count, old_reap_count, new_reap_count,
       old_locked_by, new_locked_by, new_locked_until, old_claim_token, new_claim_token,
       endpoint_status, endpoint_deleted)
     VALUES (
       NEW.id, OLD.status::text, NEW.status::text, OLD.attempt_count, NEW.attempt_count,
       OLD.client_error_count, NEW.client_error_count, OLD.reap_count, NEW.reap_count,
       OLD.locked_by, NEW.locked_by, NEW.locked_until, OLD.claim_token, NEW.claim_token,
       ep_status, ep_deleted);
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE FUNCTION murphy_audit_attempt() RETURNS trigger AS $$
   BEGIN
     INSERT INTO attempt_audit (delivery_id, attempt_no) VALUES (NEW.delivery_id, NEW.attempt_no);
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS murphy_audit_delivery ON deliveries`,
  `CREATE TRIGGER murphy_audit_delivery AFTER UPDATE ON deliveries
     FOR EACH ROW EXECUTE FUNCTION murphy_audit_delivery()`,
  `DROP TRIGGER IF EXISTS murphy_audit_attempt ON delivery_attempts`,
  `CREATE TRIGGER murphy_audit_attempt AFTER INSERT ON delivery_attempts
     FOR EACH ROW EXECUTE FUNCTION murphy_audit_attempt()`,
];

export async function installDeliveryAudit(prisma: PrismaClient): Promise<void> {
  for (const statement of INSTALL_STATEMENTS) await prisma.$executeRawUnsafe(statement);
}

export async function clearDeliveryAudit(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE delivery_audit, attempt_audit`);
}

/**
 * The legal status transitions. `failed` exists in the enum but is never used, and `cancelled`
 * can never be left (ADR 003). pending -> pending is not a transition: it covers changes to
 * other columns, which the counter rules below still check.
 */
export const LEGAL_TRANSITIONS: readonly (readonly [string, string])[] = [
  ["pending", "pending"],
  ["pending", "in_flight"],
  ["pending", "cancelled"],
  ["in_flight", "in_flight"],
  ["in_flight", "succeeded"],
  ["in_flight", "pending"],
  ["in_flight", "dead"],
  ["in_flight", "cancelled"],
  ["succeeded", "pending"],
  ["dead", "pending"],
];

export type AuditRule =
  | "illegal_transition"
  | "attempt_count_decreased"
  | "client_error_count_decreased"
  | "reap_count_decreased"
  | "lease_missing_while_in_flight"
  | "lease_kept_outside_in_flight"
  | "lease_changed_hands_while_in_flight"
  | "claimed_parked_delivery"
  | "attempt_no_not_increasing";

export interface AuditViolation {
  rule: AuditRule;
  deliveryId: string;
  seq: number;
  detail: string;
}

interface Row {
  seq: bigint;
  delivery_id: string;
  old_status: string;
  new_status: string;
  old_attempt_count: number;
  new_attempt_count: number;
  old_client_error_count: number;
  new_client_error_count: number;
  old_reap_count: number;
  new_reap_count: number;
  old_locked_by: string | null;
  new_locked_by: string | null;
  new_locked_until: Date | null;
  old_claim_token: string | null;
  new_claim_token: string | null;
  endpoint_status: string;
  endpoint_deleted: boolean;
}

/**
 * Checks the recorded history. Rows are streamed in pages because a chaos run records tens of
 * thousands of them. Returns at most `limit` violations and the total number of rows checked.
 */
export async function auditViolations(
  prisma: PrismaClient,
  limit = 100,
): Promise<{ violations: AuditViolation[]; total: number; rowsChecked: number }> {
  const violations: AuditViolation[] = [];
  let total = 0;
  const report = (violation: AuditViolation) => {
    total += 1;
    if (violations.length < limit) violations.push(violation);
  };
  const legal = new Set(LEGAL_TRANSITIONS.map(([from, to]) => `${from}>${to}`));

  let rowsChecked = 0;
  let after = 0n;
  for (;;) {
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT seq, delivery_id::text, old_status, new_status, old_attempt_count, new_attempt_count,
             old_client_error_count, new_client_error_count, old_reap_count, new_reap_count,
             old_locked_by, new_locked_by, new_locked_until, old_claim_token::text,
             new_claim_token::text, endpoint_status, endpoint_deleted
      FROM delivery_audit WHERE seq > ${after} ORDER BY seq LIMIT 5000`;
    if (rows.length === 0) break;
    for (const row of rows) checkRow(row, legal, report);
    rowsChecked += rows.length;
    after = rows[rows.length - 1]!.seq;
  }

  const attempts = await prisma.$queryRaw<
    { seq: bigint; delivery_id: string; attempt_no: number; previous: number }[]
  >`
    SELECT seq, delivery_id::text, attempt_no, previous FROM (
      SELECT seq, delivery_id, attempt_no,
             lag(attempt_no) OVER (PARTITION BY delivery_id ORDER BY seq) AS previous
      FROM attempt_audit
    ) a WHERE previous IS NOT NULL AND attempt_no <= previous`;
  for (const row of attempts) {
    report({
      rule: "attempt_no_not_increasing",
      deliveryId: row.delivery_id,
      seq: Number(row.seq),
      detail: `attempt_no ${row.previous} was followed by ${row.attempt_no}`,
    });
  }
  return { violations, total, rowsChecked };
}

function checkRow(
  row: Row,
  legal: ReadonlySet<string>,
  report: (violation: AuditViolation) => void,
): void {
  const flag = (rule: AuditRule, detail: string) =>
    report({ rule, deliveryId: row.delivery_id, seq: Number(row.seq), detail });
  const { old_status: from, new_status: to } = row;

  if (!legal.has(`${from}>${to}`)) flag("illegal_transition", `${from} -> ${to}`);

  // A replay is the only documented reset of the counters (ADR 006).
  const isReplay = (from === "succeeded" || from === "dead") && to === "pending";
  if (!isReplay) {
    if (row.new_attempt_count < row.old_attempt_count) {
      flag(
        "attempt_count_decreased",
        `${row.old_attempt_count} -> ${row.new_attempt_count} on ${from} -> ${to}`,
      );
    }
    if (row.new_client_error_count < row.old_client_error_count) {
      flag(
        "client_error_count_decreased",
        `${row.old_client_error_count} -> ${row.new_client_error_count} on ${from} -> ${to}`,
      );
    }
    if (row.new_reap_count < row.old_reap_count) {
      flag(
        "reap_count_decreased",
        `${row.old_reap_count} -> ${row.new_reap_count} on ${from} -> ${to}`,
      );
    }
  } else if (row.new_attempt_count !== 0 || row.new_reap_count !== 0) {
    flag("attempt_count_decreased", `replay left attempt_count ${row.new_attempt_count}`);
  }

  if (
    to === "in_flight" &&
    (row.new_locked_by === null || row.new_locked_until === null || row.new_claim_token === null)
  ) {
    flag("lease_missing_while_in_flight", `locked_by ${row.new_locked_by}`);
  }
  if (
    to !== "in_flight" &&
    (row.new_locked_by !== null || row.new_locked_until !== null || row.new_claim_token !== null)
  ) {
    flag("lease_kept_outside_in_flight", `status ${to}, locked_by ${row.new_locked_by}`);
  }
  if (
    from === "in_flight" &&
    to === "in_flight" &&
    (row.old_locked_by !== row.new_locked_by || row.old_claim_token !== row.new_claim_token)
  ) {
    flag("lease_changed_hands_while_in_flight", `${row.old_locked_by} -> ${row.new_locked_by}`);
  }
  if (
    from === "pending" &&
    to === "in_flight" &&
    (row.endpoint_status !== "active" || row.endpoint_deleted)
  ) {
    flag(
      "claimed_parked_delivery",
      `endpoint status ${row.endpoint_status}, deleted ${row.endpoint_deleted}`,
    );
  }
}
