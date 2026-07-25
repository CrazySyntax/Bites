import { createHarness, type Harness } from "./harness.js";
import type { TransportResponse } from "../src/delivery/httpTransport.js";

const ok = (): Promise<TransportResponse> => Promise.resolve({ statusCode: 200 });
const serverError = (): Promise<TransportResponse> => Promise.resolve({ statusCode: 500 });

async function createEndpoint(harness: Harness, url = "http://hook.test/x") {
    return harness.endpointService.create(url);
}

async function enqueueAndDrain(harness: Harness, endpointId: string, payload: unknown) {
    const { event } = await harness.eventService.accept({ endpointId, payload });
    await harness.manager.onIdle(endpointId);
    return event;
}

describe("two-level storage", () => {
    it("evicts a delivered event from memory but persists it to the database", async () => {
        const harness = createHarness({ responder: ok });
        const endpoint = await createEndpoint(harness);

        const event = await enqueueAndDrain(harness, endpoint.id, { hello: "world" });

        // Persisted to the database with status delivered (still inspectable).
        const stored = await harness.eventRepo.findById(event.id);
        expect(stored?.status).toBe("delivered");

        // Evicted from the in-memory working set (delivered is terminal).
        expect(harness.eventService.inMemoryCount()).toBe(0);

        // But still reachable via the service, which falls back to the database.
        const viaService = await harness.eventService.getOrThrow(event.id);
        expect(viaService.status).toBe("delivered");
    });

    it("evicts a dead event from memory but persists it to the database", async () => {
        const harness = createHarness({ responder: serverError });
        const endpoint = await createEndpoint(harness);

        const event = await enqueueAndDrain(harness, endpoint.id, { hello: "world" });

        // Persisted to the database with status dead (redeliverable later).
        const stored = await harness.eventRepo.findById(event.id);
        expect(stored?.status).toBe("dead");
        expect(stored?.attempts).toHaveLength(5);

        // Evicted from the in-memory working set.
        expect(harness.eventService.inMemoryCount()).toBe(0);

        // But still reachable via the service, which falls back to the database.
        const viaService = await harness.eventService.getOrThrow(event.id);
        expect(viaService.status).toBe("dead");
    });

    it("redelivers a dead event read from the database (absent from memory)", async () => {
        let succeed = false;
        const harness = createHarness({
            responder: async () => (succeed ? ok() : serverError()),
        });
        const endpoint = await createEndpoint(harness);

        const event = await enqueueAndDrain(harness, endpoint.id, { hello: "world" });
        expect(harness.eventService.inMemoryCount()).toBe(0); // dead -> evicted

        succeed = true;
        await harness.eventService.redeliver(event.id); // must find it in the DB
        await harness.manager.onIdle(endpoint.id);

        // Delivered now, persisted to the database with its full history.
        const stored = await harness.eventRepo.findById(event.id);
        expect(stored?.status).toBe("delivered");
        expect(stored?.attempts).toHaveLength(6); // 5 old + 1 new, history preserved
        expect(harness.eventService.inMemoryCount()).toBe(0); // delivered -> evicted again
    });

    it("still lists a dead event even though it is not in memory", async () => {
        const harness = createHarness({ responder: serverError });
        const endpoint = await createEndpoint(harness);

        await enqueueAndDrain(harness, endpoint.id, { hello: "world" });
        expect(harness.eventService.inMemoryCount()).toBe(0);

        const listed = await harness.eventService.listForEndpoint({
            endpointId: endpoint.id,
            status: "dead",
        });
        expect(listed.total).toBe(1);
        expect(listed.events[0].status).toBe("dead");
    });

    it("reflects an endpoint update in both memory and the database", async () => {
        const harness = createHarness({ responder: ok });
        const endpoint = await createEndpoint(harness);

        await harness.endpointService.update(endpoint.id, { status: "paused" });

        // Database reflects the change...
        const stored = await harness.endpointRepo.findById(endpoint.id);
        expect(stored?.status).toBe("paused");
        // ...and so does the service's memory-first read.
        const viaService = await harness.endpointService.findById(endpoint.id);
        expect(viaService?.status).toBe("paused");
    });

    it("keeps a dead event counted in the database after it is evicted from memory", async () => {
        // A dead event is evicted from memory but stays counted in the database, so
        // it still occupies its slot toward the per-endpoint capacity cap.
        const harness = createHarness({ responder: serverError });
        const endpoint = await createEndpoint(harness);

        const first = await harness.eventService.accept({
            endpointId: endpoint.id,
            payload: { n: 1 },
            idempotencyKey: "k1",
        });
        await harness.manager.onIdle(endpoint.id);
        expect(harness.eventService.inMemoryCount()).toBe(0); // died + evicted

        // Re-accepting the same key resolves back to the (now dead) original event
        // from the database — dedup works even after the event left memory.
        const repeat = await harness.eventService.accept({
            endpointId: endpoint.id,
            payload: { n: 1 },
            idempotencyKey: "k1",
        });
        expect(repeat.deduplicated).toBe(true);
        expect(repeat.event.id).toBe(first.event.id);
        expect(repeat.event.status).toBe("dead");

        // A distinct key creates a fresh event; the dead one is still persisted, so
        // both count toward the per-endpoint cap.
        const second = await harness.eventService.accept({
            endpointId: endpoint.id,
            payload: { n: 2 },
            idempotencyKey: "k2",
        });
        expect(second.deduplicated).toBe(false);
        expect(second.event.id).not.toBe(first.event.id);
        expect(await harness.eventRepo.countByEndpoint(endpoint.id)).toBe(2);
    });

    it("retains a freshly-accepted (pending) event in memory", async () => {
        // Only dead events are evicted; a pending event is part of the working
        // set. Pause the endpoint so nothing delivers and the event stays pending.
        const harness = createHarness({ responder: ok });
        const endpoint = await createEndpoint(harness);
        await harness.endpointService.update(endpoint.id, { status: "paused" });

        const { event } = await harness.eventService.accept({
            endpointId: endpoint.id,
            payload: { hello: "world" },
        });

        expect(event.status).toBe("pending");
        expect(harness.eventService.inMemoryCount()).toBe(1);
        const stored = await harness.eventRepo.findById(event.id);
        expect(stored?.status).toBe("pending"); // reflected in the database too
    });
});
