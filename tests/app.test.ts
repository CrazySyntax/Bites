import request from "supertest";
import { buildApp } from "../src/app.js";
import { MAX_ENDPOINTS, MAX_EVENTS_PER_ENDPOINT } from "../src/config.js";
import { createHarness, type Harness } from "./harness.js";
import type { TransportResponse } from "../src/delivery/httpTransport.js";

const ok = (): Promise<TransportResponse> => Promise.resolve({ statusCode: 200 });

function appFor(harness: Harness) {
    return buildApp({
        endpointService: harness.endpointService,
        eventService: harness.eventService,
    });
}

describe("HTTP API", () => {
    it("registers an endpoint and returns an id + secret", async () => {
        const app = appFor(createHarness({ responder: ok }));

        const res = await request(app).post("/endpoints").send({ url: "http://hook.test/x" });

        expect(res.status).toBe(201);
        expect(res.body.endpointId).toBeTruthy();
        expect(res.body.secret).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex
        expect(res.body.status).toBe("active");
    });

    it("rejects an endpoint with an invalid url", async () => {
        const app = appFor(createHarness({ responder: ok }));

        const res = await request(app).post("/endpoints").send({ url: "not-a-url" });

        expect(res.status).toBe(400);
    });

    it("accepts an event with 202 and exposes its delivery status + history", async () => {
        const harness = createHarness({ responder: ok });
        const app = appFor(harness);
        const endpoint = await harness.endpointService.create("http://hook.test/x");

        const accept = await request(app)
            .post("/events")
            .send({ endpointId: endpoint.id, payload: { hello: "world" } });

        expect(accept.status).toBe(202);
        expect(accept.body.deduplicated).toBe(false);

        await harness.manager.onIdle(endpoint.id);

        const get = await request(app).get(`/events/${accept.body.eventId}`);
        expect(get.status).toBe(200);
        expect(get.body.status).toBe("delivered");
        expect(get.body.attempts).toHaveLength(1);
        expect(get.body.attempts[0].statusCode).toBe(200);
        expect(get.body.attempts[0]).toHaveProperty("durationMs");
        // rawPayload is internal and must not leak in the API response.
        expect(get.body).not.toHaveProperty("rawPayload");
    });

    it("returns 404 when posting an event to an unknown endpoint", async () => {
        const app = appFor(createHarness({ responder: ok }));

        const res = await request(app)
            .post("/events")
            .send({ endpointId: "does-not-exist", payload: {} });

        expect(res.status).toBe(404);
    });

    it("dedupes events sharing an Idempotency-Key: same id, delivered once", async () => {
        const harness = createHarness({ responder: ok });
        const app = appFor(harness);
        const endpoint = await harness.endpointService.create("http://hook.test/x");
        const body = { endpointId: endpoint.id, payload: { n: 1 } };

        const first = await request(app).post("/events").set("Idempotency-Key", "k1").send(body);
        const second = await request(app).post("/events").set("Idempotency-Key", "k1").send(body);

        expect(first.status).toBe(202);
        expect(second.status).toBe(200); // dedupe hit
        expect(second.body.deduplicated).toBe(true);
        expect(second.body.eventId).toBe(first.body.eventId);

        await harness.manager.onIdle(endpoint.id);
        expect(harness.transport.calls).toHaveLength(1); // delivered only once
    });

    it("lists an endpoint's events newest-first, filtered by status, paginated", async () => {
        const harness = createHarness({ responder: ok });
        const app = appFor(harness);
        const endpoint = await harness.endpointService.create("http://hook.test/x");

        await request(app).post("/events").send({ endpointId: endpoint.id, payload: { n: 1 } });
        await request(app).post("/events").send({ endpointId: endpoint.id, payload: { n: 2 } });
        await request(app).post("/events").send({ endpointId: endpoint.id, payload: { n: 3 } });
        await harness.manager.onIdle(endpoint.id);

        const res = await request(app)
            .get(`/endpoints/${endpoint.id}/events`)
            .query({ status: "delivered", limit: 2, offset: 0 });

        expect(res.status).toBe(200);
        expect(res.body.total).toBe(3);
        expect(res.body.events).toHaveLength(2);
        // Newest first: event {n:3} was created last.
        expect(res.body.events.map((e: { payload: { n: number } }) => e.payload.n)).toEqual([3, 2]);
    });

    it("rejects an unknown status filter with 400", async () => {
        const harness = createHarness({ responder: ok });
        const app = appFor(harness);
        const endpoint = await harness.endpointService.create("http://hook.test/x");

        const res = await request(app)
            .get(`/endpoints/${endpoint.id}/events`)
            .query({ status: "bogus" });

        expect(res.status).toBe(400);
    });

    it("pauses and resumes an endpoint via PATCH", async () => {
        const harness = createHarness({ responder: ok });
        const app = appFor(harness);
        const endpoint = await harness.endpointService.create("http://hook.test/x");

        await request(app).patch(`/endpoints/${endpoint.id}`).send({ status: "paused" });
        await request(app).post("/events").send({ endpointId: endpoint.id, payload: { n: 1 } });
        await harness.manager.onIdle(endpoint.id);
        expect(harness.transport.calls).toHaveLength(0);

        await request(app).patch(`/endpoints/${endpoint.id}`).send({ status: "active" });
        await harness.manager.onIdle(endpoint.id);
        expect(harness.transport.calls).toHaveLength(1);
    });

    it("returns 500 once the endpoint capacity limit is exceeded", async () => {
        const app = appFor(createHarness({ responder: ok }));

        // Fill to capacity — every registration up to the limit succeeds.
        for (let i = 0; i < MAX_ENDPOINTS; i++) {
            const res = await request(app).post("/endpoints").send({ url: "http://hook.test/x" });
            expect(res.status).toBe(201);
        }

        // The one that would exceed the limit is rejected with 500.
        const overflow = await request(app).post("/endpoints").send({ url: "http://hook.test/x" });
        expect(overflow.status).toBe(500);
        expect(overflow.body.error).toMatch(/endpoint limit/i);
    });

    it("returns 500 once an endpoint's event capacity limit is exceeded", async () => {
        const harness = createHarness({ responder: ok });
        const app = appFor(harness);
        const endpoint = await harness.endpointService.create("http://hook.test/x");

        // Fill this endpoint to its event capacity — each accept returns 202.
        for (let i = 0; i < MAX_EVENTS_PER_ENDPOINT; i++) {
            const res = await request(app)
                .post("/events")
                .send({ endpointId: endpoint.id, payload: { n: i } });
            expect(res.status).toBe(202);
        }

        // The next event for this endpoint is rejected with 500.
        const overflow = await request(app)
            .post("/events")
            .send({ endpointId: endpoint.id, payload: { n: MAX_EVENTS_PER_ENDPOINT } });
        expect(overflow.status).toBe(500);
        expect(overflow.body.error).toMatch(/event limit/i);
    });

    it("returns 400 for a malformed JSON body", async () => {
        const app = appFor(createHarness({ responder: ok }));

        const res = await request(app)
            .post("/endpoints")
            .set("Content-Type", "application/json")
            .send('{"url": ');

        expect(res.status).toBe(400);
    });
});
