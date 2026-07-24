import type { DeliveryConfig } from "../src/config.js";
import { computeBackoffMs } from "../src/delivery/backoff.js";

const config: DeliveryConfig = {
    maxAttempts: 5,
    timeoutMs: 5_000,
    backoffBaseMs: 500,
    backoffFactor: 2,
    backoffMaxMs: 30_000,
};

describe("computeBackoffMs", () => {
    const noJitter = () => 0;

    it("grows exponentially with the attempt count (no jitter)", () => {
        expect(computeBackoffMs(1, config, noJitter)).toBe(500); // 500 * 2^0
        expect(computeBackoffMs(2, config, noJitter)).toBe(1_000); // 500 * 2^1
        expect(computeBackoffMs(3, config, noJitter)).toBe(2_000); // 500 * 2^2
        expect(computeBackoffMs(4, config, noJitter)).toBe(4_000); // 500 * 2^3
    });

    it("caps the exponential term at backoffMaxMs", () => {
        const smallCap: DeliveryConfig = { ...config, backoffMaxMs: 3_000 };
        expect(computeBackoffMs(10, smallCap, noJitter)).toBe(3_000);
    });

    it("adds jitter in [0, backoffBaseMs)", () => {
        // rng = 1 (its supremum) yields base delay + full base of jitter.
        expect(computeBackoffMs(1, config, () => 1)).toBe(1_000); // 500 + 500
        // A mid-range rng lands between the no-jitter and full-jitter bounds.
        const mid = computeBackoffMs(1, config, () => 0.5);
        expect(mid).toBeGreaterThanOrEqual(500);
        expect(mid).toBeLessThan(1_000);
    });
});
