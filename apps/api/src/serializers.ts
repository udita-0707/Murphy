import type { DeliveryRecord, EndpointRecord, EventWithDeliveries } from "@murphy/db";

export function serializeEndpoint(endpoint: EndpointRecord) {
  return {
    id: endpoint.id,
    url: endpoint.url,
    description: endpoint.description,
    event_filter: endpoint.eventFilter,
    status: endpoint.status,
    created_at: endpoint.createdAt.toISOString(),
  };
}

export function serializeDelivery(delivery: DeliveryRecord) {
  return {
    id: delivery.id,
    endpoint_id: delivery.endpointId,
    status: delivery.status,
    attempt_count: delivery.attemptCount,
    next_attempt_at: delivery.nextAttemptAt.toISOString(),
    last_status_code: delivery.lastStatusCode,
    last_error: delivery.lastError,
    created_at: delivery.createdAt.toISOString(),
    completed_at: delivery.completedAt?.toISOString() ?? null,
  };
}

export function serializeEvent(event: EventWithDeliveries) {
  return {
    id: event.id,
    type: event.type,
    payload: event.payload,
    idempotency_key: event.idempotencyKey,
    created_at: event.createdAt.toISOString(),
    deliveries: event.deliveries.map(serializeDelivery),
  };
}
