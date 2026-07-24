import { Router } from "express";
import type { EndpointService } from "../services/endpointService.js";
import type { EventService } from "../services/eventService.js";
import { serializeEvent } from "./serialize.js";

/**
 * Endpoint management routes. Express 5 forwards rejected promises from async
 * handlers to the error middleware, so handlers just `await` and throw.
 */
export function endpointsRouter(
    endpointService: EndpointService,
    eventService: EventService,
): Router {
    const router = Router();

    // POST /endpoints — register an endpoint, returns its id + signing secret.
    router.post("/", async (req, res) => {
        const { url } = req.body ?? {};
        const endpoint = await endpointService.create(url);
        res.status(201).json({
            endpointId: endpoint.id,
            secret: endpoint.secret,
            url: endpoint.url,
            status: endpoint.status,
        });
    });

    // PATCH /endpoints/:id — update url and/or status (active | paused).
    router.patch("/:id", async (req, res) => {
        const { url, status } = req.body ?? {};
        const endpoint = await endpointService.update(req.params.id, { url, status });
        res.json({
            endpointId: endpoint.id,
            url: endpoint.url,
            status: endpoint.status,
        });
    });

    // GET /endpoints/:id/events?status=&limit=&offset= — newest first, paginated.
    router.get("/:id/events", async (req, res) => {
        const result = await eventService.listForEndpoint({
            endpointId: req.params.id,
            status: typeof req.query.status === "string" ? req.query.status : undefined,
            limit: parseIntParam(req.query.limit),
            offset: parseIntParam(req.query.offset),
        });
        res.json({
            events: result.events.map(serializeEvent),
            total: result.total,
            limit: result.limit,
            offset: result.offset,
        });
    });

    return router;
}

/** Parses a query param to a number, or undefined if absent/blank. */
function parseIntParam(value: unknown): number | undefined {
    if (typeof value !== "string" || value.trim() === "") return undefined;
    return Number(value);
}
