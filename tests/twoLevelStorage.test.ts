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
    it("keeps a delivered event in memory and persists it to the database", async () => {
        const harness = createHarness({ responder: ok });
        const endpoint = await createEndpoint(harness);

        const event = await enqueueAndDrain(harness, endpoint.id, { hello: "world" });

        // Database (repository) reflects the delivered state...
        const stored = await harness.eventRepo.findById(event.id);
        expect(stored?.status).toBe("delivered");
        // ...and the event remains in the process working set (not terminal-failed).
        expect(harness.eventService.inMemoryCount()).toBe(1);
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

        // Delivered now, reflected in both levels.
        const stored = await harness.eventRepo.findById(event.id);
        expect(stored?.status).toBe("delivered");
        expect(stored?.attempts).toHaveLength(6); // 5 old + 1 new, history preserved
        expect(harness.eventService.inMemoryCount()).toBe(1); // re-admitted to memory
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

    it("keeps capacity + idempotency correct after dead events are evicted", async () => {
        // A dead event stays counted in the database, so it still occupies its
        // slot toward the per-endpoint cap and its idempotency key still dedupes.
        const harness = createHarness({ responder: serverError });
        const endpoint = await createEndpoint(harness);

        const first = await harness.eventService.accept({
            endpointId: endpoint.id,
            payload: { n: 1 },
            idempotencyKey: "k1",
        });
        await harness.manager.onIdle(endpoint.id);
        expect(harness.eventService.inMemoryCount()).toBe(0); // died + evicted

        // Same idempotency key still resolves to the original (now dead) event.
        const second = await harness.eventService.accept({
            endpointId: endpoint.id,
            payload: { n: 1 },
            idempotencyKey: "k1",
        });
        expect(second.deduplicated).toBe(true);
        expect(second.event.id).toBe(first.event.id);
        expect(second.event.status).toBe("dead");
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
