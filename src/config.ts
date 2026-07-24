/**
 * Delivery tuning knobs. Grouped into a type so the delivery engine can be
 * constructed with shrunk values in tests (tiny backoff, fewer attempts).
 */
export interface DeliveryConfig {
    /** Max delivery attempts before an event is marked `dead`. */
    maxAttempts: number;
    /** Per-attempt timeout in ms; a request exceeding this counts as a failure. */
    timeoutMs: number;
    /** Base backoff delay in ms (delay before retry #2). */
    backoffBaseMs: number;
    /** Exponential growth factor between retries. */
    backoffFactor: number;
    /** Upper bound on a single backoff delay. */
    backoffMaxMs: number;
}

export const defaultDeliveryConfig: DeliveryConfig = {
    maxAttempts: 5,
    timeoutMs: 5_000,
    backoffBaseMs: 500,
    backoffFactor: 2,
    backoffMaxMs: 30_000,
};

export const PORT = Number(process.env.PORT) || 3000;

/** Pagination defaults for the endpoint-events listing. */
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;
