/**
 * Domain types shared across the service.
 *
 * Timestamps are ISO-8601 strings so they serialize cleanly over HTTP and are
 * human-readable in the API responses / attempt history.
 */

export type EndpointStatus = "active" | "paused";

/**
 * Event lifecycle:
 *   pending    -> not yet delivered: queued, currently in flight, or waiting out
 *                 a backoff between retries (attempts remaining)
 *   delivered  -> received a 2xx (terminal)
 *   dead       -> exhausted all attempts (terminal until redelivered)
 */
export type EventStatus = "pending" | "delivered" | "dead";

export interface Endpoint {
    id: string;
    url: string;
    /** HMAC key handed to the customer so they can verify the X-Signature header. */
    secret: string;
    status: EndpointStatus;
    createdAt: string;
}

/** One delivery attempt. Exactly one of `statusCode` / `error` is set. */
export interface Attempt {
    attemptNumber: number;
    timestamp: string;
    /** HTTP status code the endpoint responded with (any status, not only 2xx). */
    statusCode?: number;
    /** Network error / timeout message when no HTTP response was received. */
    error?: string;
    durationMs: number;
}

export interface WebhookEvent {
    id: string;
    endpointId: string;
    /**
     * `JSON.stringify(payload)` captured once at creation. These are the exact
     * bytes sent as the request body AND the body portion of what we sign — the
     * X-Signature is HMAC over `<endpointId>.<rawPayload>` — so the signature
     * always matches what the customer receives.
     */
    rawPayload: string;
    status: EventStatus;
    /** Full attempt history, preserved across redelivery. */
    attempts: Attempt[];
    /** Failed attempts in the current delivery lifecycle; reset to 0 on redeliver. */
    attemptCount: number;
    idempotencyKey?: string;
    createdAt: string;
}
