import { loadEnv, resolveEnvPath } from "./env.js";

// Populate process.env before reading any value below. Done at module load so
// every importer sees the resolved config. The env file path is taken from the
// optional `--env-path <path>` CLI argument; without it we fall back to a `.env`
// in the working directory, and a missing `.env` is a no-op (defaults apply).
// An explicit `--env-path` that does not exist is a hard error.
const envPath = resolveEnvPath();
if (envPath !== undefined) {
    loadEnv(envPath, { required: true });
} else {
    loadEnv();
}

/**
 * Reads a numeric env var, falling back to `fallback` when it is unset or not a
 * finite number. Keeps a malformed `.env` entry from silently becoming `NaN`.
 */
function envNumber(key: string, fallback: number): number {
    const raw = process.env[key];
    if (raw === undefined || raw.trim() === "") return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/** Reads a string env var, falling back to `fallback` when unset or blank. */
function envString(key: string, fallback: string): string {
    const raw = process.env[key];
    return raw === undefined || raw.trim() === "" ? fallback : raw;
}

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
    maxAttempts: envNumber("MAX_ATTEMPTS", 5),
    timeoutMs: envNumber("TIMEOUT_MS", 5_000),
    backoffBaseMs: envNumber("BACKOFF_BASE_MS", 500),
    backoffFactor: envNumber("BACKOFF_FACTOR", 2),
    backoffMaxMs: envNumber("BACKOFF_MAX_MS", 30_000),
};

export const PORT = envNumber("PORT", 3000);

/** Pagination defaults for the endpoint-events listing. */
export const DEFAULT_PAGE_LIMIT = envNumber("DEFAULT_PAGE_LIMIT", 20);
export const MAX_PAGE_LIMIT = envNumber("MAX_PAGE_LIMIT", 100);

/**
 * Capacity limits guarding the in-memory store against unbounded growth.
 * Exceeding either is treated as a server-side capacity failure (HTTP 500).
 */
export const MAX_ENDPOINTS = envNumber("MAX_ENDPOINTS", 100);
export const MAX_EVENTS_PER_ENDPOINT = envNumber("MAX_EVENTS_PER_ENDPOINT", 50);

/**
 * Snapshot file the database dump/load endpoints read and write, resolved
 * relative to the process working directory. A fresh, empty snapshot is written
 * here on every process start (see `index.ts`); `POST /database/dump` overwrites
 * it with the live state and `POST /database/load` restores from it.
 */
export const DATABASE_FILE = envString("DATABASE_FILE", "database.json");

/**
 * Size of `EventService`'s in-memory working set per endpoint. The service keeps
 * at most this many non-dead events per endpoint resident to bound the heap;
 * beyond it, new events are persisted to the database only. When an endpoint's
 * resident count falls to zero, the service reloads up to this many recent
 * non-dead events from the database.
 */
export const MAX_IN_MEMORY_EVENTS_PER_ENDPOINT = envNumber(
    "MAX_IN_MEMORY_EVENTS_PER_ENDPOINT",
    10,
);
