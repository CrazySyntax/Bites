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

describe("database dump", () => {
    let dir: string;
    let file: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "bites-db-"));
        file = join(dir, "database.json");
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("dumps endpoints and events to the file", async () => {
        const source = createHarness({ responder: ok, databaseFile: file });
        const endpoint = await source.endpointService.create("http://hook.test/x");
        const { event } = await source.eventService.accept({
            endpointId: endpoint.id,
            payload: { hello: "world" },
        });
        await source.manager.onIdle(endpoint.id);

        const dumped = await source.databaseService.dump();
        expect(dumped).toEqual({ endpoints: 1, events: 1 });

        // The file is valid JSON carrying both collections and the current state.
        const snapshot = JSON.parse(await readFile(file, "utf8"));
        expect(snapshot.version).toBe(1);
        expect(snapshot.endpoints).toHaveLength(1);
        expect(snapshot.endpoints[0].id).toBe(endpoint.id);
        expect(snapshot.endpoints[0].url).toBe("http://hook.test/x");
        expect(snapshot.events).toHaveLength(1);
        expect(snapshot.events[0].id).toBe(event.id);
        expect(snapshot.events[0].status).toBe("delivered");
    });

    it("dumps a dead event with its full attempt history", async () => {
        const source = createHarness({ responder: serverError, databaseFile: file });
        const endpoint = await source.endpointService.create("http://hook.test/x");
        const { event } = await source.eventService.accept({
            endpointId: endpoint.id,
            payload: { n: 1 },
        });
        await source.manager.onIdle(endpoint.id);
        expect((await source.eventRepo.findById(event.id))?.status).toBe("dead");

        await source.databaseService.dump();

        const snapshot = JSON.parse(await readFile(file, "utf8"));
        expect(snapshot.events).toHaveLength(1);
        expect(snapshot.events[0].status).toBe("dead");
        expect(snapshot.events[0].attempts).toHaveLength(5);
    });

    it("dumps a pending event captured mid-flight", async () => {
        // Accept an event whose delivery never completes (hangs), so it is
        // persisted while still pending, then dump.
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

        const snapshot = JSON.parse(await readFile(file, "utf8"));
        expect(snapshot.events).toHaveLength(1);
        expect(snapshot.events[0].status).toBe("pending");
    });

    it("initEmptyFile writes an empty snapshot", async () => {
        const harness = createHarness({ responder: ok, databaseFile: file });
        await harness.databaseService.initEmptyFile();

        const snapshot = JSON.parse(await readFile(file, "utf8"));
        expect(snapshot.version).toBe(1);
        expect(snapshot.endpoints).toEqual([]);
        expect(snapshot.events).toEqual([]);
    });

    describe("HTTP route", () => {
        it("POST /database/dump writes the live database to the file", async () => {
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

            const snapshot = JSON.parse(await readFile(file, "utf8"));
            expect(snapshot.endpoints).toHaveLength(1);
            expect(snapshot.events).toHaveLength(1);
        });
    });
});
