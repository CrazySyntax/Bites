import { createHarness, type Harness } from "./harness.js";
import type { TransportResponse } from "../src/delivery/httpTransport.js";
import { MAX_IN_MEMORY_EVENTS_PER_ENDPOINT } from "../src/config.js";

const ok = (): Promise<TransportResponse> => Promise.resolve({ statusCode: 200 });

const CAP = MAX_IN_MEMORY_EVENTS_PER_ENDPOINT;

async function createPausedEndpoint(harness: Harness, url = "http://hook.test/x") {
    // Pause so accepted events stay `pending` in memory (nothing delivers),
    // letting a test observe the working set without the delivery engine racing.
    const endpoint = await harness.endpointService.create(url);
    await harness.endpointService.update(endpoint.id, { status: "paused" });
    return endpoint;
}

async function acceptN(harness: Harness, endpointId: string, n: number) {
    const events = [];
    for (let i = 0; i < n; i++) {
        const { event } = await harness.eventService.accept({ endpointId, payload: { n: i } });
        events.push(event);
    }
    return events;
}

describe("bounded per-endpoint in-memory cache", () => {
    it(`caps the working set at ${CAP} non-dead events per endpoint`, async () => {
        const harness = createHarness({ responder: ok });
        const endpoint = await createPausedEndpoint(harness);

        await acceptN(harness, endpoint.id, CAP + 1);

        // Only the cap is resident; the overflow event lives in the database only.
        expect(harness.eventService.inMemoryCountForEndpoint(endpoint.id)).toBe(CAP);
        expect(harness.eventService.inMemoryCount()).toBe(CAP);

        // Every event — including the overflow one — is durably persisted.
        expect(await harness.eventRepo.countByEndpoint(endpoint.id)).toBe(CAP + 1);
    });

    it("still resolves an overflow (database-only) event via database fallback", async () => {
        const harness = createHarness({ responder: ok });
        const endpoint = await createPausedEndpoint(harness);

        const events = await acceptN(harness, endpoint.id, CAP + 1);
        const overflow = events[CAP]; // the (CAP+1)-th, never admitted to memory

        const viaService = await harness.eventService.getOrThrow(overflow.id);
        expect(viaService.id).toBe(overflow.id);
        expect(viaService.status).toBe("pending");
    });

    it("bounds each endpoint independently", async () => {
        const harness = createHarness({ responder: ok });
        const a = await createPausedEndpoint(harness, "http://hook.test/a");
        const b = await createPausedEndpoint(harness, "http://hook.test/b");

        await acceptN(harness, a.id, CAP + 1);
        await acceptN(harness, b.id, CAP + 1);

        expect(harness.eventService.inMemoryCountForEndpoint(a.id)).toBe(CAP);
        expect(harness.eventService.inMemoryCountForEndpoint(b.id)).toBe(CAP);
        expect(harness.eventService.inMemoryCount()).toBe(CAP * 2);
    });

    it("reloads recent events from the database when an endpoint's cache drains", async () => {
        const harness = createHarness({ responder: ok });
        const endpoint = await createPausedEndpoint(harness);

        // CAP resident (the first CAP accepted) + 1 database-only overflow.
        const events = await acceptN(harness, endpoint.id, CAP + 1);
        expect(harness.eventService.inMemoryCountForEndpoint(endpoint.id)).toBe(CAP);

        // Mark the CAP resident events dead one by one, as the delivery engine
        // would via `save`. Each dead event is evicted; when the last one drains
        // the endpoint to zero, the service reloads recent non-dead events from
        // the database — here, the single pending overflow event.
        for (let i = 0; i < CAP; i++) {
            const event = events[i];
            event.status = "dead";
            await harness.eventService.save(event);
        }

        expect(harness.eventService.inMemoryCountForEndpoint(endpoint.id)).toBe(1);

        // The reloaded event is the overflow one (the only remaining non-dead event).
        const reloaded = await harness.eventService.getOrThrow(events[CAP].id);
        expect(reloaded.status).toBe("pending");
    });

    it("does not reload while an endpoint still has resident events", async () => {
        const harness = createHarness({ responder: ok });
        const endpoint = await createPausedEndpoint(harness);

        const events = await acceptN(harness, endpoint.id, CAP + 1);

        // Kill one resident event: the endpoint still has CAP-1 resident, so no
        // reload happens and the overflow event stays database-only.
        events[0].status = "dead";
        await harness.eventService.save(events[0]);

        expect(harness.eventService.inMemoryCountForEndpoint(endpoint.id)).toBe(CAP - 1);
    });
});
