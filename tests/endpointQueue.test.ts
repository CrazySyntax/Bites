import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { DeliveryConfig } from "../src/config.js";
import type { DeliveryDeps } from "../src/delivery/deliveryDeps.js";
import { EndpointQueue } from "../src/delivery/endpointQueue.js";
import type { TransportResponse } from "../src/delivery/httpTransport.js";
import type { EventStore } from "../src/delivery/stores.js";
import { InMemoryEventRepository } from "../src/repositories/inMemory/inMemoryEventRepository.js";
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
    /** Real event store to read/persist through. Defaults to a stub that always
     * returns `options.event` and echoes saves — enough for single-attempt tests
     * that assert against the live event object rather than a backing store. */
    events?: EventStore;
}): { queue: EndpointQueue; save: jest.Mock<(e: WebhookEvent) => Promise<WebhookEvent>> } {
    const store: EventStore = options.events ?? {
        findById: async () => options.event,
        save: async (e: WebhookEvent) => e,
    };
    // Spy that still writes through to `store`, so call counts and real
    // persistence (when a repository is supplied) are both observable.
    const save = jest.fn((e: WebhookEvent) => store.save(e));
    const deps: DeliveryDeps = {
        endpoints: { findById: async () => ENDPOINT },
        events: { findById: (id: string) => store.findById(id), save },
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

/**
 * End-to-end test of the worker loop (not the private single-attempt method):
 * an event whose first delivery fails is retried *in place* after the
 * exponential backoff sleep, and the retry succeeds. Fake timers let us
 * fast-forward the backoff deterministically and prove the retry is gated on
 * the timer rather than firing immediately.
 */
describe("EndpointQueue run loop", () => {
    // A config with a visible backoff window so we can assert the retry only
    // fires once the exponential-backoff timer elapses.
    const scenarioConfig: DeliveryConfig = {
        maxAttempts: 5,
        timeoutMs: TIMEOUT_MS,
        backoffBaseMs: 100,
        backoffFactor: 2,
        backoffMaxMs: 10_000,
    };

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2026-07-24T00:00:00.000Z"));
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it("retries after exponential backoff and succeeds on the second attempt", async () => {
        // The endpoint fails the first attempt (500), then recovers: every later
        // attempt gets a 200. rng = 0 (from buildQueue) means no jitter, so the
        // backoff is exactly the deterministic exponential term.
        const transport = new FakeTransport(async (_req, callIndex) =>
            (callIndex === 1 ? { statusCode: 500 } : { statusCode: 200 }) as TransportResponse,
        );

        // Persist through a real repository (the "database", the source of truth).
        // The loop reads a fresh copy from the store each iteration and writes it
        // back on save, so we assert status against the DB rather than a local ref.
        const eventRepo = new InMemoryEventRepository();
        const event = makeEvent();
        await eventRepo.create(event);
        const { queue, save } = buildQueue({
            transport,
            event,
            config: scenarioConfig,
            events: eventRepo,
        });

        // Drive the real worker loop (enqueue -> wake -> run), not the private attempt.
        queue.enqueue(event.id);

        // The first attempt runs and fails; the loop then parks on the backoff sleep
        // with the event still at the head of the queue. The async timer helper
        // interleaves microtask flushing with timer advancement, so the attempt's
        // promise chain fully settles before we assert.
        await jest.advanceTimersByTimeAsync(0);
        expect(transport.calls).toHaveLength(1);

        // In the database, the event is `pending` after the first (failed) invocation:
        // one failed attempt recorded, still retryable (attempts remain).
        const afterFirst = await eventRepo.findById(event.id);
        expect(afterFirst?.status).toBe("pending");
        expect(afterFirst?.attemptCount).toBe(1);
        expect(afterFirst?.attempts).toHaveLength(1);
        expect(afterFirst?.attempts[0].statusCode).toBe(500);

        // Backoff after the first failure: base * factor^0 = 100ms, no jitter.
        const backoffMs = scenarioConfig.backoffBaseMs; // 100
        // Just before the backoff elapses the retry has NOT fired: still one attempt,
        // and the database still shows the event as pending.
        await jest.advanceTimersByTimeAsync(backoffMs - 1);
        expect(transport.calls).toHaveLength(1);
        expect((await eventRepo.findById(event.id))?.status).toBe("pending");

        // Crossing the backoff boundary wakes the loop, which retries the *same*
        // head event; this time the endpoint answers 200 and the event is delivered.
        await jest.advanceTimersByTimeAsync(1);
        await queue.onIdle();

        expect(transport.calls).toHaveLength(2);

        // In the database, the event is now `delivered` after the second invocation.
        const afterSecond = await eventRepo.findById(event.id);
        expect(afterSecond?.status).toBe("delivered");
        expect(afterSecond?.attempts).toHaveLength(2);
        expect(afterSecond?.attempts[1].statusCode).toBe(200);
        expect(afterSecond?.attempts[1].error).toBeUndefined();
        // The failure count is not bumped on the successful retry.
        expect(afterSecond?.attemptCount).toBe(1);
        // Saved once per attempt: the recorded failure, then the delivery.
        expect(save).toHaveBeenCalledTimes(2);
        // Backoff timer + per-attempt timeout are both cleared — nothing leaks.
        expect(jest.getTimerCount()).toBe(0);
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
type WithSign = { sign(endpointId: string, rawBody: string, secret: string): string };
function sign(endpointId: string, rawBody: string, secret: string): string {
    const { queue } = buildQueue({
        transport: new FakeTransport((req) => respondNever(req)),
        event: makeEvent(),
    });
    return (queue as unknown as WithSign).sign(endpointId, rawBody, secret);
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
    it("produces an sha256-prefixed hex HMAC of the endpoint id joined to the body", () => {
        const secret = "super-secret";
        const endpointId = "ep-1";
        const body = JSON.stringify({ hello: "world" });

        const expectedHex = createHmac("sha256", secret)
            .update(`${endpointId}.${body}`, "utf8")
            .digest("hex");

        expect(sign(endpointId, body, secret)).toBe(`sha256=${expectedHex}`);
    });

    it("is deterministic for the same endpoint id + body + secret", () => {
        expect(sign("ep-1", "payload", "k")).toBe(sign("ep-1", "payload", "k"));
    });

    it("changes when the secret changes", () => {
        expect(sign("ep-1", "payload", "k1")).not.toBe(sign("ep-1", "payload", "k2"));
    });

    it("changes when a single byte of the body changes", () => {
        expect(sign("ep-1", '{"a":1}', "k")).not.toBe(sign("ep-1", '{"a":2}', "k"));
    });

    it("changes when the endpoint id changes", () => {
        expect(sign("ep-1", "payload", "k")).not.toBe(sign("ep-2", "payload", "k"));
    });
});