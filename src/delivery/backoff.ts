import type { DeliveryConfig } from "../config.js";

/**
 * Exponential backoff with full jitter.
 *
 * `attemptCount` is the number of failures so far (>= 1). The base delay grows
 * as base * factor^(attemptCount-1), capped at backoffMaxMs, plus a random
 * jitter in [0, base) to avoid synchronized retries ("thundering herd").
 *
 * `rng` is injectable so tests can pass `() => 0` for deterministic delays.
 */
export function computeBackoffMs(
    attemptCount: number,
    config: DeliveryConfig,
    rng: () => number = Math.random,
): number {
    const exponential = config.backoffBaseMs * config.backoffFactor ** (attemptCount - 1);
    const capped = Math.min(exponential, config.backoffMaxMs);
    const jitter = rng() * config.backoffBaseMs;
    return Math.round(capped + jitter);
}
