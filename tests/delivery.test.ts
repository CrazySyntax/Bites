import { createHarness, respondNever, type Harness } from "./harness.js";
import type { TransportRequest, TransportResponse } from "../src/delivery/httpTransport.js";

const ok = (): Promise<TransportResponse> => Promise.resolve({ statusCode: 200 });
const serverError = (): Promise<TransportResponse> => Promise.resolve({ statusCode: 500 });

async function createEndpoint(harness: Harness, url = "http://hook.test/x") {
    return harness.endpointService.create(url);
}

/** Enqueue an event and wait for its endpoint's queue to drain. */
async function enqueueAndDrain(harness: Harness, endpointId: string, payload: unknown) {
    const { event } = await harness.eventService.accept({ endpointId, payload });
    await harness.manager.onIdle(endpointId);
    return event;
}

describe("delivery engine", () => {
    it("delivers events for the same endpoint strictly in order, even across retries", async () => {
        // e1 fails twice then succeeds; e2 and e3 must not overtake it.
        const attemptsByBody = new Map<string, number>();
        const harness = createHarness({
            responder: async (req: TransportRequest) => {
                const n = (attemptsByBody.get(req.body) ?? 0) + 1;
                attemptsByBody.set(req.body, n);
                if (req.body.includes('"n":1') && n < 3) return serverError();
                return ok();
            },
        });
        const endpoint = await createEndpoint(harness);

        await harness.eventService.accept({ endpointId: endpoint.id, payload: { n: 1 } });
        await harness.eventService.accept({ endpointId: endpoint.id, payload: { n: 2 } });
        await harness.eventService.accept({ endpointId: endpoint.id, payload: { n: 3 } });
        await harness.manager.onIdle(endpoint.id);

        // The last (successful) delivery of each event must be ordered 1, 2, 3.
        const deliveredOrder = harness.transport.calls
            .filter((c) => c.body.includes('"n"'))
            .map((c) => JSON.parse(c.body).n);
        // e1 appears 3 times (2 fails + 1 success), then e2, then e3.
        expect(deliveredOrder).toEqual([1, 1, 1, 2, 3]);
    });

    it("holds the second event until the first exhausts all 5 attempts and dies", async () => {
        // Event 1 fails every time; event 2 must not be attempted until event 1
        // has failed its full 5 attempts and been marked dead.
        const bodiesInOrder: number[] = [];
        const harness = createHarness({
            responder: async (req: TransportRequest) => {
                const n = JSON.parse(req.body).n;
                bodiesInOrder.push(n);
                // While event 1 is still being retried, event 2 must never appear.
                if (n === 2) {
                    const firstIsDone = bodiesInOrder.filter((x) => x === 1).length >= 5;
                    expect(firstIsDone).toBe(true);
                }
                return n === 1 ? serverError() : ok();
            },
        });
        const endpoint = await createEndpoint(harness);

        const first = await harness.eventService.accept({ endpointId: endpoint.id, payload: { n: 1 } });
        const second = await harness.eventService.accept({ endpointId: endpoint.id, payload: { n: 2 } });
        await harness.manager.onIdle(endpoint.id);

        // Event 1 exhausts all 5 attempts (all 500) before event 2 is even touched.
        expect(bodiesInOrder).toEqual([1, 1, 1, 1, 1, 2]);

        const firstStored = await harness.eventRepo.findById(first.event.id);
        const secondStored = await harness.eventRepo.findById(second.event.id);
        expect(firstStored?.status).toBe("dead");
        expect(firstStored?.attempts).toHaveLength(5);
        expect(secondStored?.status).toBe("delivered");
    });

    it("does not let a slow/down endpoint delay deliveries to other endpoints", async () => {
        // Endpoint A hangs forever (until timeout); endpoint B should deliver immediately.
        const harness = createHarness({
            responder: async (req: TransportRequest) => {
                if (req.url.includes("slow")) return respondNever(req);
                return ok();
            },
        });
        const slow = await createEndpoint(harness, "http://slow.test/hook");
        const fast = await createEndpoint(harness, "http://fast.test/hook");

        // Enqueue to the slow endpoint first; it will park on its timeout.
        await harness.eventService.accept({ endpointId: slow.id, payload: { a: 1 } });
        // The fast endpoint should complete without waiting for the slow one.
        const fastEvent = await enqueueAndDrain(harness, fast.id, { b: 1 });

        const stored = await harness.eventRepo.findById(fastEvent.id);
        expect(stored?.status).toBe("delivered");

        // Clean up the slow queue so no timer leaks past the test.
        harness.manager.shutdown();
        await harness.manager.onIdle(slow.id);
    });

    it("retries with backoff and marks the event dead after maxAttempts failures", async () => {
        const harness = createHarness({ responder: serverError });
        const endpoint = await createEndpoint(harness);

        const event = await enqueueAndDrain(harness, endpoint.id, { hello: "world" });

        const stored = await harness.eventRepo.findById(event.id);
        expect(stored?.status).toBe("dead");
        expect(stored?.attempts).toHaveLength(5); // maxAttempts
        expect(stored?.attempts.every((a) => a.statusCode === 500)).toBe(true);
        expect(stored?.attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3, 4, 5]);
    });

    it("persists a retryable failure as pending in the database between attempts", async () => {
        // First attempt fails but retries remain, so the event is put back to
        // `pending` and must be written through to the database as such. We gate
        // the second attempt so we can observe the persisted state mid-lifecycle,
        // before the event reaches a terminal (`delivered`) status.
        let attempt = 0;
        let releaseSecond!: () => void;
        const secondGate = new Promise<void>((resolve) => {
            releaseSecond = resolve;
        });
        let signalSecondReached!: () => void;
        const secondReached = new Promise<void>((resolve) => {
            signalSecondReached = resolve;
        });

        const harness = createHarness({
            responder: async () => {
                attempt += 1;
                if (attempt === 1) return serverError(); // fail once -> pending + backoff
                signalSecondReached(); // second attempt is now in flight
                await secondGate; // hold it here so we can inspect the DB
                return ok();
            },
        });
        const endpoint = await createEndpoint(harness);

        const { event } = await harness.eventService.accept({
            endpointId: endpoint.id,
            payload: { hello: "world" },
        });

        // By the time the second attempt starts, the first failure has already been
        // persisted: the database reflects `pending` with one recorded attempt.
        await secondReached;
        const midFlight = await harness.eventRepo.findById(event.id);
        expect(midFlight?.status).toBe("pending");
        expect(midFlight?.attemptCount).toBe(1);
        expect(midFlight?.attempts).toHaveLength(1);

        // Let the second attempt succeed and confirm the database now reflects it.
        releaseSecond();
        await harness.manager.onIdle(endpoint.id);
        const done = await harness.eventRepo.findById(event.id);
        expect(done?.status).toBe("delivered");
    });

    it("counts a timeout as a failed attempt", async () => {
        // Endpoint always hangs -> every attempt aborts at the timeout.
        const harness = createHarness({ responder: (req) => respondNever(req) });
        const endpoint = await createEndpoint(harness);

        const event = await enqueueAndDrain(harness, endpoint.id, { hello: "world" });

        const stored = await harness.eventRepo.findById(event.id);
        expect(stored?.status).toBe("dead");
        expect(stored?.attempts).toHaveLength(5);
        expect(stored?.attempts.every((a) => a.error === "timeout")).toBe(true);
        expect(stored?.attempts.every((a) => a.statusCode === undefined)).toBe(true);
    });

    it("signs each delivery with an HMAC-SHA256 of the exact body sent", async () => {
        const { createHmac } = await import("node:crypto");
        const harness = createHarness({ responder: ok });
        const endpoint = await createEndpoint(harness);

        await enqueueAndDrain(harness, endpoint.id, { order: 42 });

        const call = harness.transport.calls[0];
        const expected =
            "sha256=" + createHmac("sha256", endpoint.secret).update(call.body, "utf8").digest("hex");
        expect(call.headers["x-signature"]).toBe(expected);
        expect(call.headers["content-type"]).toBe("application/json");
        expect(call.headers["x-event-id"]).toBeTruthy();
        expect(call.headers["x-attempt"]).toBe("1");
    });

    it("queues events while paused and delivers them in order on resume", async () => {
        const harness = createHarness({ responder: ok });
        const endpoint = await createEndpoint(harness);

        await harness.endpointService.update(endpoint.id, { status: "paused" });

        await harness.eventService.accept({ endpointId: endpoint.id, payload: { n: 1 } });
        await harness.eventService.accept({ endpointId: endpoint.id, payload: { n: 2 } });

        // Give the (paused) queue a chance to run — it should not deliver anything.
        await harness.manager.onIdle(endpoint.id);
        expect(harness.transport.calls).toHaveLength(0);

        await harness.endpointService.update(endpoint.id, { status: "active" });
        await harness.manager.onIdle(endpoint.id);

        expect(harness.transport.calls.map((c) => JSON.parse(c.body).n)).toEqual([1, 2]);
    });

    it("marks an event dead immediately if it fails while the endpoint is paused", async () => {
        // The endpoint is paused mid-attempt; the in-flight delivery then fails.
        // Per the documented assumption, that event goes straight to `dead`
        // instead of being retried, even though it has attempts left.
        let harness: Harness;
        harness = createHarness({
            responder: async (_req) => {
                // Pause the endpoint while this first attempt is in flight, then fail it.
                harness.manager.pause(endpoint.id);
                return serverError();
            },
        });
        const endpoint = await createEndpoint(harness);

        const event = await enqueueAndDrain(harness, endpoint.id, { hello: "world" });

        const stored = await harness.eventRepo.findById(event.id);
        expect(stored?.status).toBe("dead");
        expect(stored?.attempts).toHaveLength(1); // no retries — died on the first failure
        expect(stored?.attemptCount).toBe(1);
        expect(harness.transport.calls).toHaveLength(1);
    });

    it("redelivers a dead event: resets the counter and preserves history", async () => {
        // First drive the event to dead (always 500), then make it succeed on redeliver.
        let succeed = false;
        const harness = createHarness({
            responder: async () => (succeed ? ok() : serverError()),
        });
        const endpoint = await createEndpoint(harness);

        const event = await enqueueAndDrain(harness, endpoint.id, { hello: "world" });
        const dead = await harness.eventRepo.findById(event.id);
        expect(dead?.status).toBe("dead");
        expect(dead?.attempts).toHaveLength(5);

        succeed = true;
        await harness.eventService.redeliver(event.id);
        await harness.manager.onIdle(endpoint.id);

        const redelivered = await harness.eventRepo.findById(event.id);
        expect(redelivered?.status).toBe("delivered");
        expect(redelivered?.attemptCount).toBe(0); // reset on success
        expect(redelivered?.attempts).toHaveLength(6); // 5 old + 1 new, history preserved
        expect(redelivered?.attempts[5].statusCode).toBe(200);
    });

    it("rejects redelivery of a non-dead event", async () => {
        const harness = createHarness({ responder: ok });
        const endpoint = await createEndpoint(harness);
        const event = await enqueueAndDrain(harness, endpoint.id, { hello: "world" });

        await expect(harness.eventService.redeliver(event.id)).rejects.toMatchObject({ status: 409 });
    });
});
