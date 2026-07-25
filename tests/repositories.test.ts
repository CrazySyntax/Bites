import { InMemoryEndpointRepository } from "../src/repositories/inMemory/inMemoryEndpointRepository.js";
import { InMemoryEventRepository } from "../src/repositories/inMemory/inMemoryEventRepository.js";
import type { Endpoint, WebhookEvent } from "../src/types.js";

function makeEndpoint(overrides: Partial<Endpoint> = {}): Endpoint {
    return {
        id: "ep-1",
        url: "http://hook.test/x",
        secret: "s3cr3t",
        status: "active",
        createdAt: "2026-07-24T00:00:00.000Z",
        ...overrides,
    };
}

function makeEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
    return {
        id: "ev-1",
        endpointId: "ep-1",
        payload: { hello: "world" },
        rawPayload: '{"hello":"world"}',
        status: "pending",
        attempts: [],
        attemptCount: 0,
        createdAt: "2026-07-24T00:00:00.000Z",
        ...overrides,
    };
}

// The repository is the single source of truth: a change to an entity is
// reflected in the store ONLY when it goes back through the repo (create /
// save / update). Mutating a returned object must never leak into the store.
describe("in-memory repositories return isolated copies", () => {
    describe("endpoints", () => {
        it("does not let a mutation of a created object leak into the store", async () => {
            const repo = new InMemoryEndpointRepository();
            const input = makeEndpoint();

            const created = await repo.create(input);
            created.url = "http://evil.test/mutated";
            input.status = "paused"; // mutate the original caller-held object too

            const stored = await repo.findById("ep-1");
            expect(stored?.url).toBe("http://hook.test/x");
            expect(stored?.status).toBe("active");
        });

        it("does not let a mutation of a found object leak into the store", async () => {
            const repo = new InMemoryEndpointRepository();
            await repo.create(makeEndpoint());

            const first = await repo.findById("ep-1");
            first!.status = "paused"; // mutate without calling update()

            const second = await repo.findById("ep-1");
            expect(second?.status).toBe("active");
        });

        it("reflects a change only after it goes through update()", async () => {
            const repo = new InMemoryEndpointRepository();
            await repo.create(makeEndpoint());

            await repo.update("ep-1", { status: "paused" });

            const stored = await repo.findById("ep-1");
            expect(stored?.status).toBe("paused");
        });

        it("leaves omitted fields untouched (partial patch)", async () => {
            const repo = new InMemoryEndpointRepository();
            await repo.create(makeEndpoint());

            // Patch only `status`; `url` must survive, not be wiped to undefined.
            await repo.update("ep-1", { status: "paused" });

            const stored = await repo.findById("ep-1");
            expect(stored?.status).toBe("paused");
            expect(stored?.url).toBe("http://hook.test/x");
        });

        it("treats an explicit `undefined` field as 'leave unchanged'", async () => {
            const repo = new InMemoryEndpointRepository();
            await repo.create(makeEndpoint());

            // A patch carrying `undefined` (e.g. status omitted from the request
            // body) must not drop the stored field. Regression: a blind spread
            // wiped `status` off the record entirely.
            await repo.update("ep-1", { url: "http://hook.test/y", status: undefined });

            const stored = await repo.findById("ep-1");
            expect(stored?.url).toBe("http://hook.test/y");
            expect(stored?.status).toBe("active");
        });
    });

    describe("events", () => {
        it("does not let a mutation of a found event (incl. nested attempts) leak", async () => {
            const repo = new InMemoryEventRepository();
            await repo.create(makeEvent());

            const found = await repo.findById("ev-1");
            found!.status = "delivered";
            found!.attemptCount = 99;
            found!.attempts.push({
                attemptNumber: 1,
                timestamp: "2026-07-24T00:00:01.000Z",
                statusCode: 500,
                durationMs: 5,
            });

            const stored = await repo.findById("ev-1");
            expect(stored?.status).toBe("pending");
            expect(stored?.attemptCount).toBe(0);
            expect(stored?.attempts).toHaveLength(0); // nested array is isolated too
        });

        it("does not let a mutation of the created event leak into the store", async () => {
            const repo = new InMemoryEventRepository();
            const input = makeEvent();

            await repo.create(input);
            input.status = "dead";
            (input.payload as { hello: string }).hello = "mutated"; // deep field

            const stored = await repo.findById("ev-1");
            expect(stored?.status).toBe("pending");
            expect((stored?.payload as { hello: string }).hello).toBe("world");
        });

        it("reflects a change only after it goes through save()", async () => {
            const repo = new InMemoryEventRepository();
            const created = await repo.create(makeEvent());

            created.status = "delivered";
            created.attempts.push({
                attemptNumber: 1,
                timestamp: "2026-07-24T00:00:01.000Z",
                statusCode: 200,
                durationMs: 3,
            });
            await repo.save(created);

            const stored = await repo.findById("ev-1");
            expect(stored?.status).toBe("delivered");
            expect(stored?.attempts).toHaveLength(1);
        });

        it("returns isolated copies from list()", async () => {
            const repo = new InMemoryEventRepository();
            await repo.create(makeEvent());

            const { events } = await repo.list({ endpointId: "ep-1", limit: 10, offset: 0 });
            events[0].status = "dead"; // mutate the listed copy

            const stored = await repo.findById("ev-1");
            expect(stored?.status).toBe("pending");
        });
    });
});
