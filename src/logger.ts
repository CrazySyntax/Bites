import { inspect } from "node:util";
import { LOG_LEVEL } from "./config.js";
import type { Endpoint } from "./types.js";

/**
 * Minimal logging seam. Two levels are all this service needs: INFO for entity
 * changes and retry scheduling, ERROR for delivery failures/timeouts.
 *
 * Each class that logs constructs its own `ConsoleLogger` directly (it is not
 * injected) — there is no shared logging state to thread, and the verbosity is
 * driven uniformly by the `LOG_LEVEL` env var through the constructor default.
 */
export type LogLevel = "info" | "error" | "silent";

export interface Logger {
    info(msg: string, data?: unknown): void;
    error(msg: string, data?: unknown): void;
}

/** Resolve the configured `LOG_LEVEL` string to a known level (default `info`). */
function resolveLevel(raw: string): LogLevel {
    return raw === "error" || raw === "silent" ? raw : "info";
}

/**
 * Human-readable console logger. Writes one line per event:
 * `<iso> INFO  <msg> <inspected data>` (INFO -> stdout, ERROR -> stderr).
 * The data object is rendered with `node:util`'s `inspect` (a built-in — no new
 * dependency, matching the project's hand-rolled, zero-runtime-dep style) kept
 * on a single line and depth-bounded so nested attempt history stays readable.
 *
 * `minLevel` (defaulted from `LOG_LEVEL`) gates output: `info` logs both levels,
 * `error` suppresses INFO, `silent` suppresses everything. It can be overridden
 * per instance (used in unit tests to exercise each level explicitly).
 */
export class ConsoleLogger implements Logger {
    constructor(private readonly minLevel: LogLevel = resolveLevel(LOG_LEVEL)) {}

    info(msg: string, data?: unknown): void {
        if (this.minLevel === "info") this.write("INFO", console.log, msg, data);
    }

    error(msg: string, data?: unknown): void {
        if (this.minLevel !== "silent") this.write("ERROR", console.error, msg, data);
    }

    private write(
        label: string,
        sink: (line: string) => void,
        msg: string,
        data?: unknown,
    ): void {
        const prefix = `${new Date().toISOString()} ${label.padEnd(5)} ${msg}`;
        sink(data === undefined ? prefix : `${prefix} ${inspect(data, { depth: 4, breakLength: Infinity })}`);
    }
}

/**
 * Returns a copy of an endpoint safe to log: the `secret` is the customer's HMAC
 * signing key, so it is replaced with a placeholder. Keeping redaction here means
 * every call site that logs an endpoint is safe by construction. Events carry no
 * secret (their payload is the customer's own data, already exposed via the API),
 * so they are logged as-is.
 */
export function redactEndpoint(endpoint: Endpoint): Endpoint {
    return { ...endpoint, secret: "[redacted]" };
}
