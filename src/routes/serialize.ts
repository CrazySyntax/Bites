import type { WebhookEvent } from "../types.js";

/**
 * Public JSON shape of an event. Exposes the full attempt history and the
 * decoded `payload`, but hides the internal `rawPayload` (the exact signed byte
 * string). The event stores only `rawPayload`, so `payload` is reconstructed by
 * parsing it back — the bytes originated from `JSON.stringify(payload)`, so this
 * round-trips faithfully.
 */
export function serializeEvent(event: WebhookEvent) {
    return {
        id: event.id,
        endpointId: event.endpointId,
        status: event.status,
        payload: JSON.parse(event.rawPayload),
        attemptCount: event.attemptCount,
        createdAt: event.createdAt,
        attempts: event.attempts,
    };
}
