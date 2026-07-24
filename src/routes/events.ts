import { Router } from "express";
import type { EventService } from "../services/eventService.js";
import { serializeEvent } from "./serialize.js";

export function eventsRouter(eventService: EventService): Router {
    const router = Router();

    // POST /events — accept an event; delivery happens asynchronously.
    // Optional Idempotency-Key header dedupes retries of the same request.
    router.post("/", async (req, res) => {
        const { endpointId, payload } = req.body ?? {};
        const idempotencyKey = headerValue(req.headers["idempotency-key"]);

        const { event, deduplicated } = await eventService.accept({
            endpointId,
            payload,
            idempotencyKey,
        });

        // 200 for a dedupe hit (already accepted earlier), 202 for a fresh accept.
        res.status(deduplicated ? 200 : 202).json({ eventId: event.id, deduplicated });
    });

    // GET /events/:id — delivery status + full attempt history.
    router.get("/:id", async (req, res) => {
        const event = await eventService.getOrThrow(req.params.id);
        res.json(serializeEvent(event));
    });

    // POST /events/:id/redeliver — re-queue a dead event (counter resets).
    router.post("/:id/redeliver", async (req, res) => {
        const event = await eventService.redeliver(req.params.id);
        res.status(202).json(serializeEvent(event));
    });

    return router;
}

function headerValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) return value[0];
    return value;
}
