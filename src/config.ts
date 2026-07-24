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

/**
 * Capacity limits guarding the in-memory store against unbounded growth.
 * Exceeding either is treated as a server-side capacity failure (HTTP 500).
 */
export const MAX_ENDPOINTS = 100;
export const MAX_EVENTS_PER_ENDPOINT = 50;

/**
 * Snapshot file the database dump/load endpoints read and write, resolved
 * relative to the process working directory. A fresh, empty snapshot is written
 * here on every process start (see `index.ts`); `POST /database/dump` overwrites
 * it with the live state and `POST /database/load` restores from it.
 */
export const DATABASE_FILE = "database.json";

/**
 * Size of `EventService`'s in-memory working set per endpoint. The service keeps
 * at most this many non-dead events per endpoint resident to bound the heap;
 * beyond it, new events are persisted to the database only. When an endpoint's
 * resident count falls to zero, the service reloads up to this many recent
 * non-dead events from the database.
 */
export const MAX_IN_MEMORY_EVENTS_PER_ENDPOINT = 10;
