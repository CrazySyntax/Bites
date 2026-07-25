import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { DeliveryConfig } from "../src/config.js";
import type { DeliveryDeps } from "../src/delivery/deliveryDeps.js";
import { EndpointQueue } from "../src/delivery/endpointQueue.js";
import type { TransportResponse } from "../src/delivery/httpTransport.js";
import type { Endpoint, WebhookEvent } from "../src/types.js";
import { FakeTransport, respondNever } from "./harness.js";

/**
 * Unit tests for {@link EndpointQueue.attemptDelivery} in isolation from the
 * run loop / backoff. We construct the queue directly with hand-rolled deps and
 * invoke the (private) attemptDelivery method so we can drive a single attempt
 * and assert exactly how it records the outcome on the event.
 *
 * `jest.useFakeTimers()` lets us fast-forward the per-attempt timeout timer
 * (config.timeoutMs) deterministically, so we can simulate an endpoint that
 * never responds and verify the attempt aborts and is recorded as a failure.
 */

const TIMEOUT_MS = 5_000;

const testConfig: DeliveryConfig = {
    maxAttempts: 5,
    timeoutMs: TIMEOUT_MS,
    backoffBaseMs: 1,
    backoffFactor: 2,
    backoffMaxMs: 20,
};

const ENDPOINT: Endpoint = {
    id: "ep_1",
    url: "http://hook.test/x",
    secret: "shhh",
    status: "active",
    createdAt: "2026-07-24T00:00:00.000Z",
};

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
    const payload = overrides.payload ?? { hello: "world" };
    return {
        id: "evt_1",
        endpointId: ENDPOINT.id,
        payload,
        rawPayload: JSON.stringify(payload),
        status: "pending",
        attempts: [],
        attemptCount: 0,
        createdAt: "2026-07-24T00:00:00.000Z",
        ...overrides,
    };
}

/** Reach the private single-attempt method for focused unit testing. */
type WithAttemptDelivery = { attemptDelivery(event: WebhookEvent): Promise<void> };
function attemptDelivery(queue: EndpointQueue, event: WebhookEvent): Promise<void> {
    return (queue as unknown as WithAttemptDelivery).attemptDelivery(event);
}

/**
 * Yield to the microtask queue a few times. Fake timers do NOT fake promises,
 * so this lets attemptDelivery advance past its `await findById` and get the
 * request in flight (abort listener attached) before we fast-forward the clock.
 */
async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

function buildQueue(options: {
    transport: FakeTransport;
    event: WebhookEvent;
    config?: DeliveryConfig;
}): { queue: EndpointQueue; save: jest.Mock<(e: WebhookEvent) => Promise<WebhookEvent>> } {
    const save = jest.fn(async (e: WebhookEvent) => e);
    const deps: DeliveryDeps = {
        endpoints: { findById: async () => ENDPOINT },
        events: { findById: async () => options.event, save },
        transport: options.transport,
        config: options.config ?? testConfig,
        now: () => Date.now(), // faked by jest.useFakeTimers -> deterministic durations
        rng: () => 0,
    };
    return { queue: new EndpointQueue(ENDPOINT.id, deps), save };
}

describe("EndpointQueue.attemptDelivery", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2026-07-24T00:00:00.000Z"));
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it("aborts and records a failure when the endpoint does not respond within the timeout", async () => {
        // Endpoint hangs forever; only the per-attempt timeout can end the attempt.
        const transport = new FakeTransport((req) => respondNever(req));
        const event = makeEvent();
        const { queue, save } = buildQueue({ transport, event });

        const inFlight = attemptDelivery(queue, event);

        // Let the request reach the transport (abort listener attached) and confirm
        // nothing has been recorded yet — the attempt is genuinely in flight.
        await flushMicrotasks();
        expect(transport.calls).toHaveLength(1);
        expect(event.attempts).toHaveLength(0);
        expect(save).not.toHaveBeenCalled();

        // Simulate 5 seconds elapsing with no response -> the timeout fires the abort.
        jest.advanceTimersByTime(TIMEOUT_MS);
        await inFlight;

        // The event is treated as a failure: one failed attempt is recorded and saved.
        expect(event.attempts).toHaveLength(1);
        const [attempt] = event.attempts;
        expect(attempt.error).toBe("timeout");
        expect(attempt.statusCode).toBeUndefined();
        expect(attempt.attemptNumber).toBe(1);
        expect(attempt.durationMs).toBe(TIMEOUT_MS);

        // Not delivered; failure counted; still retryable (attempts remain), so pending.
        expect(event.status).toBe("pending");
        expect(event.attemptCount).toBe(1);
        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledWith(event);
    });

    it("does not abort before the timeout elapses", async () => {
        // Boundary check: at 4999ms the attempt is still in flight; the 5000th ms aborts it.
        const transport = new FakeTransport((req) => respondNever(req));
        const event = makeEvent();
        const { queue, save } = buildQueue({ transport, event });

        const inFlight = attemptDelivery(queue, event);
        await flushMicrotasks();

        jest.advanceTimersByTime(TIMEOUT_MS - 1);
        await flushMicrotasks();
        expect(event.attempts).toHaveLength(0);
        expect(save).not.toHaveBeenCalled();

        // Cross the timeout boundary -> now it aborts and is recorded as a failure.
        jest.advanceTimersByTime(1);
        await inFlight;
        expect(event.attempts).toHaveLength(1);
        expect(event.attempts[0].error).toBe("timeout");
    });

    it("records a delivered outcome on a 2xx response and clears the timeout", async () => {
        const transport = new FakeTransport(async () => ({ statusCode: 200 }) as TransportResponse);
        const event = makeEvent();
        const { queue, save } = buildQueue({ transport, event });

        await attemptDelivery(queue, event);

        expect(event.status).toBe("delivered");
        expect(event.attempts).toHaveLength(1);
        expect(event.attempts[0].statusCode).toBe(200);
        expect(event.attempts[0].error).toBeUndefined();
        expect(event.attemptCount).toBe(0); // no failure counted on success
        expect(save).toHaveBeenCalledTimes(1);

        // The abort timer must have been cleared on success — no lingering timers.
        expect(jest.getTimerCount()).toBe(0);
    });

    it("records a failure with the status code on a non-2xx response", async () => {
        const transport = new FakeTransport(async () => ({ statusCode: 500 }) as TransportResponse);
        const event = makeEvent();
        const { queue, save } = buildQueue({ transport, event });

        await attemptDelivery(queue, event);

        expect(event.status).toBe("pending"); // failed but attempts remain
        expect(event.attemptCount).toBe(1);
        expect(event.attempts).toHaveLength(1);
        expect(event.attempts[0].statusCode).toBe(500);
        expect(event.attempts[0].error).toBeUndefined();
        expect(save).toHaveBeenCalledTimes(1);
    });
});

const config: DeliveryConfig = {
    maxAttempts: 5,
    timeoutMs: 5_000,
    backoffBaseMs: 500,
    backoffFactor: 2,
    backoffMaxMs: 30_000,
};

/**
 * `computeBackoffMs` is a private method on EndpointQueue (there is no standalone
 * `backoff` module). It is a pure function of its arguments, so we reach it on a
 * throwaway queue instance for focused unit testing — mirroring how the private
 * `attemptDelivery` is reached above.
 */
type WithComputeBackoffMs = {
    computeBackoffMs(attemptCount: number, config: DeliveryConfig, rng: () => number): number;
};
function computeBackoffMs(attemptCount: number, config: DeliveryConfig, rng: () => number): number {
    const { queue } = buildQueue({
        transport: new FakeTransport((req) => respondNever(req)),
        event: makeEvent(),
    });
    return (queue as unknown as WithComputeBackoffMs).computeBackoffMs(attemptCount, config, rng);
}

/**
 * `sign` is a private method on EndpointQueue (there is no standalone `signer`
 * module). It is a pure function of its arguments, so we reach it on a throwaway
 * queue instance for focused unit testing — mirroring `computeBackoffMs` above.
 */
type WithSign = { sign(rawBody: string, secret: string): string };
function sign(rawBody: string, secret: string): string {
    const { queue } = buildQueue({
        transport: new FakeTransport((req) => respondNever(req)),
        event: makeEvent(),
    });
    return (queue as unknown as WithSign).sign(rawBody, secret);
}

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

describe("sign", () => {
    it("produces an sha256-prefixed hex HMAC of the body", () => {
        const secret = "super-secret";
        const body = JSON.stringify({ hello: "world" });

        const expectedHex = createHmac("sha256", secret).update(body, "utf8").digest("hex");

        expect(sign(body, secret)).toBe(`sha256=${expectedHex}`);
    });

    it("is deterministic for the same body + secret", () => {
        expect(sign("payload", "k")).toBe(sign("payload", "k"));
    });

    it("changes when the secret changes", () => {
        expect(sign("payload", "k1")).not.toBe(sign("payload", "k2"));
    });

    it("changes when a single byte of the body changes", () => {
        expect(sign('{"a":1}', "k")).not.toBe(sign('{"a":2}', "k"));
    });
});