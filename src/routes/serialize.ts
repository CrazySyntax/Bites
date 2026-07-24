import type { WebhookEvent } from "../types.js";

/**
 * Public JSON shape of an event. Exposes the full attempt history but hides the
 * internal `rawPayload` (the client already has `payload`; rawPayload is only
 * meaningful as the signed byte string).
 */
export function serializeEvent(event: WebhookEvent) {
    return {
        id: event.id,
        endpointId: event.endpointId,
        status: event.status,
        payload: event.payload,
        attemptCount: event.attemptCount,
        createdAt: event.createdAt,
        attempts: event.attempts,
    };
}
