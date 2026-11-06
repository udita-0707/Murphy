/** The shape of `GET /v1/runs/:id`, as far as timelines need it. */
export interface LiveAttempt {
  attempt_no: number;
  at_ms: number | null;
  status: number | null;
  error: string | null;
}

export interface LiveDelivery {
  delivery_id: string;
  step: string;
  attempts: LiveAttempt[];
}

/** Which copy of a step a delivery is: 1 for the first to be sent, 2 for a duplicate. */
export function copyNumber(
  deliveries: readonly LiveDelivery[],
  step: string,
  deliveryId: string,
): number {
  const copies = deliveries
    .filter((d) => d.step === step)
    .sort((x, y) => (x.attempts[0]?.at_ms ?? Infinity) - (y.attempts[0]?.at_ms ?? Infinity));
  return copies.findIndex((d) => d.delivery_id === deliveryId) + 1;
}

/** Which faults belong on one attempt: a retry or the first copy of a duplicate is not itself the fault. */
export function faultsFor(kinds: readonly string[], copy: number, attemptNo: number): string[] {
  return kinds.filter((kind) =>
    kind === "duplicate" ? copy !== 1 : attemptNo === 1 && copy === 1,
  );
}

export function faultsOnAttempt(
  deliveries: readonly LiveDelivery[],
  kinds: readonly string[],
  step: string,
  deliveryId: string,
  attemptNo: number,
): string[] {
  return faultsFor(kinds, copyNumber(deliveries, step, deliveryId), attemptNo);
}
