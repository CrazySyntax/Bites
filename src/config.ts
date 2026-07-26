import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";
import { loadEnv, resolveEnvPath } from "./env.js";

// Repo root, derived from this module's own location rather than the process
// working directory. `config.js` sits one level below the root in both dev
// (`src/`, run by tsx) and prod (`dist/`, the compiled output), so `..` from
// here resolves to the root in either case. Anchoring here keeps file paths
// stable no matter what cwd the process was launched with (e.g. an IDE run
// config starting in `src/`).
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

/**
 * Console log verbosity, read by every `ConsoleLogger` (`src/logger.ts`).
 * `info` (default) logs entity changes and retry schedules; `error` suppresses
 * those and logs only delivery failures/timeouts; `silent` disables all logging.
 */
export const LOG_LEVEL = envString("LOG_LEVEL", "info");

/** Pagination defaults for the endpoint-events listing. */
export const DEFAULT_PAGE_LIMIT = envNumber("DEFAULT_PAGE_LIMIT", 20);
export const MAX_PAGE_LIMIT = envNumber("MAX_PAGE_LIMIT", 100);

/**
 * Snapshot file the database dump endpoint writes. A relative `DATABASE_FILE`
 * (including the default) is anchored to the project root, so the snapshot
 * always lands in `<root>/stores/` regardless of the process working directory;
 * an absolute `DATABASE_FILE` is honored as-is. A fresh, empty snapshot is
 * written here on every process start (see `index.ts`); `POST /database/dump`
 * overwrites it with the live state.
 */
const databaseFileSetting = envString("DATABASE_FILE", "stores/database.json");
export const DATABASE_FILE = isAbsolute(databaseFileSetting)
    ? databaseFileSetting
    : resolve(PROJECT_ROOT, databaseFileSetting);

/**
 * Size of `EventService`'s in-memory working set per endpoint. The service keeps
 * at most this many non-dead events per endpoint resident to bound the heap;
 * beyond it, new events are persisted to the database only. When an endpoint's
 * resident count falls to zero, the service reloads up to this many oldest
 * non-dead events from the database (preserving FIFO delivery order).
 */
export const MAX_IN_MEMORY_EVENTS_PER_ENDPOINT = envNumber(
    "MAX_IN_MEMORY_EVENTS_PER_ENDPOINT",
    10,
);
