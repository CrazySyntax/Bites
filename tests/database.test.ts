import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { buildApp } from "../src/app.js";
import type { TransportResponse } from "../src/delivery/httpTransport.js";
import { createHarness, type Harness } from "./harness.js";

const ok = (): Promise<TransportResponse> => Promise.resolve({ statusCode: 200 });
const serverError = (): Promise<TransportResponse> => Promise.resolve({ statusCode: 500 });

/** A transport that hangs forever, so an accepted event stays `pending`. */
const hang = (): Promise<TransportResponse> => new Promise<TransportResponse>(() => {});

function appFor(harness: Harness) {
    return buildApp({
        endpointService: harness.endpointService,
        eventService: harness.eventService,
        databaseService: harness.databaseService,
    });
}

describe("database dump/load", () => {
    let dir: string;
    let file: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "bites-db-"));
        file = join(dir, "database.json");
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("dumps endpoints and events to the file and reloads them into a fresh graph", async () => {
        const source = createHarness({ responder: ok, databaseFile: file });
        const endpoint = await source.endpointService.create("http://hook.test/x");
        const { event } = await source.eventService.accept({
            endpointId: endpoint.id,
            payload: { hello: "world" },
        });
        await source.manager.onIdle(endpoint.id);

        const dumped = await source.databaseService.dump();
        expect(dumped).toEqual({ endpoints: 1, events: 1 });

        // The file is valid JSON carrying both collections.
        const snapshot = JSON.parse(await readFile(file, "utf8"));
        expect(snapshot.endpoints).toHaveLength(1);
        expect(snapshot.events).toHaveLength(1);

        // A brand-new graph (simulating a restarted process) loads the file.
        const restored = createHarness({ responder: ok, databaseFile: file });
        const loaded = await restored.databaseService.load();
        expect(loaded).toEqual({ endpoints: 1, events: 1 });

        // Both the endpoint and the event are queryable through the services.
        const restoredEndpoint = await restored.endpointService.getOrThrow(endpoint.id);
        expect(restoredEndpoint.url).toBe("http://hook.test/x");
        const restoredEvent = await restored.eventService.getOrThrow(event.id);
        expect(restoredEvent.status).toBe("delivered");
    });

    it("preserves a dead event (with its attempt history) across dump/load", async () => {
        const source = createHarness({ responder: serverError, databaseFile: file });
        const endpoint = await source.endpointService.create("http://hook.test/x");
        const { event } = await source.eventService.accept({
            endpointId: endpoint.id,
            payload: { n: 1 },
        });
        await source.manager.onIdle(endpoint.id);
        expect((await source.eventRepo.findById(event.id))?.status).toBe("dead");

        await source.databaseService.dump();

        const restored = createHarness({ responder: ok, databaseFile: file });
        await restored.databaseService.load();

        const restoredEvent = await restored.eventService.getOrThrow(event.id);
        expect(restoredEvent.status).toBe("dead");
        expect(restoredEvent.attempts).toHaveLength(5);
        // A restored dead event is still redeliverable.
        await restored.eventService.redeliver(event.id);
        await restored.manager.onIdle(endpoint.id);
        expect((await restored.eventRepo.findById(event.id))?.status).toBe("delivered");
    });

    it("re-queues restored pending events so delivery resumes after load", async () => {
        // Source process: accept an event whose delivery never completes (hangs),
        // so it is persisted while still pending, then dump.
        const source = createHarness({ responder: hang, databaseFile: file });
        const endpoint = await source.endpointService.create("http://hook.test/x");
        const { event } = await source.eventService.accept({
            endpointId: endpoint.id,
            payload: { n: 1 },
        });
        // Give the hung attempt a tick to start, then snapshot mid-flight.
        await new Promise((r) => setTimeout(r, 5));
        expect((await source.eventRepo.findById(event.id))?.status).toBe("pending");
        await source.databaseService.dump();

        // Restarted process: the endpoint now succeeds. Loading must re-enqueue the
        // pending event and drive it to delivery.
        const restored = createHarness({ responder: ok, databaseFile: file });
        await restored.databaseService.load();
        await restored.manager.onIdle(endpoint.id);

        expect((await restored.eventRepo.findById(event.id))?.status).toBe("delivered");
        expect(restored.transport.calls).toHaveLength(1);
    });

    it("does not deliver restored events for a paused endpoint", async () => {
        const source = createHarness({ responder: hang, databaseFile: file });
        const endpoint = await source.endpointService.create("http://hook.test/x");
        await source.endpointService.update(endpoint.id, { status: "paused" });
        const { event } = await source.eventService.accept({
            endpointId: endpoint.id,
            payload: { n: 1 },
        });
        await source.databaseService.dump();

        // On load the endpoint is paused, so its queue must not deliver the backlog.
        const restored = createHarness({ responder: ok, databaseFile: file });
        await restored.databaseService.load();
        await restored.manager.onIdle(endpoint.id);

        expect(restored.transport.calls).toHaveLength(0);
        expect((await restored.eventRepo.findById(event.id))?.status).toBe("pending");

        // Resuming the endpoint then drains the restored backlog.
        await restored.endpointService.update(endpoint.id, { status: "active" });
        await restored.manager.onIdle(endpoint.id);
        expect((await restored.eventRepo.findById(event.id))?.status).toBe("delivered");
    });

    it("initEmptyFile writes an empty snapshot that loads into an empty database", async () => {
        const harness = createHarness({ responder: ok, databaseFile: file });
        await harness.databaseService.initEmptyFile();

        const snapshot = JSON.parse(await readFile(file, "utf8"));
        expect(snapshot.endpoints).toEqual([]);
        expect(snapshot.events).toEqual([]);

        const loaded = await harness.databaseService.load();
        expect(loaded).toEqual({ endpoints: 0, events: 0 });
    });

    describe("HTTP routes", () => {
        it("POST /database/dump then POST /database/load round-trips over HTTP", async () => {
            const source = createHarness({ responder: ok, databaseFile: file });
            const sourceApp = appFor(source);
            const create = await request(sourceApp)
                .post("/endpoints")
                .send({ url: "http://hook.test/x" });
            const endpointId = create.body.endpointId;
            await request(sourceApp).post("/events").send({ endpointId, payload: { n: 1 } });
            await source.manager.onIdle(endpointId);

            const dump = await request(sourceApp).post("/database/dump");
            expect(dump.status).toBe(200);
            expect(dump.body).toEqual({ dumped: true, endpoints: 1, events: 1 });

            const restored = createHarness({ responder: ok, databaseFile: file });
            const restoredApp = appFor(restored);
            const load = await request(restoredApp).post("/database/load");
            expect(load.status).toBe(200);
            expect(load.body).toEqual({ loaded: true, endpoints: 1, events: 1 });

            const get = await request(restoredApp).get(`/endpoints/${endpointId}/events`);
            expect(get.body.total).toBe(1);
        });

        it("POST /database/load returns 500 when the snapshot file is missing", async () => {
            const harness = createHarness({ responder: ok, databaseFile: file });
            const app = appFor(harness);

            // No dump / init has been performed, so the file does not exist.
            const res = await request(app).post("/database/load");
            expect(res.status).toBe(500);
        });
    });
});
