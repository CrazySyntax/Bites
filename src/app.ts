import express, {type Express, type NextFunction, type Request, type Response} from "express";
import { databaseRouter } from "./routes/database.js";
import { endpointsRouter } from "./routes/endpoints.js";
import { eventsRouter } from "./routes/events.js";
import type { DatabaseService } from "./services/databaseService.js";
import type { EndpointService } from "./services/endpointService.js";
import type { EventService } from "./services/eventService.js";
import {AppError} from "./errors.js";

export interface AppServices {
    endpointService: EndpointService;
    eventService: EventService;
    databaseService: DatabaseService;
}

/**
 * Centralized error mapping. Typed {@link AppError}s become their carried
 * status; anything unexpected becomes a 500. Placed last in the middleware
 * chain (Express 5 forwards rejected async handlers here automatically).
 */
export function errorHandler(
    err: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
): void {
    if (err instanceof AppError) {
        res.status(err.status).json({ error: err.message });
        return;
    }

    // Malformed JSON bodies surface as SyntaxError from express.json().
    if (err instanceof SyntaxError && "body" in err) {
        res.status(400).json({ error: "invalid JSON body" });
        return;
    }

    console.error("Unhandled error:", err);
    res.status(500).json({ error: "internal server error" });
}

/**
 * Builds the Express app from already-constructed services. Kept separate from
 * `index.ts` (which binds a port) so tests can drive it with supertest and
 * injected fakes without opening a socket.
 */
export function buildApp(services: AppServices): Express {
    const app = express();
    app.use(express.json());

    app.use("/endpoints", endpointsRouter(services.endpointService, services.eventService));
    app.use("/events", eventsRouter(services.eventService));
    app.use("/database", databaseRouter(services.databaseService));

    app.use(errorHandler);
    return app;
}
