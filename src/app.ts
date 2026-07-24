import express, { type Express } from "express";
import { errorHandler } from "./middleware/errorHandler.js";
import { databaseRouter } from "./routes/database.js";
import healthRouter from "./routes/health.js";
import { endpointsRouter } from "./routes/endpoints.js";
import { eventsRouter } from "./routes/events.js";
import type { DatabaseService } from "./services/databaseService.js";
import type { EndpointService } from "./services/endpointService.js";
import type { EventService } from "./services/eventService.js";

export interface AppServices {
    endpointService: EndpointService;
    eventService: EventService;
    databaseService: DatabaseService;
}

/**
 * Builds the Express app from already-constructed services. Kept separate from
 * `index.ts` (which binds a port) so tests can drive it with supertest and
 * injected fakes without opening a socket.
 */
export function buildApp(services: AppServices): Express {
    const app = express();
    app.use(express.json());

    app.use("/health", healthRouter);
    app.use("/endpoints", endpointsRouter(services.endpointService, services.eventService));
    app.use("/events", eventsRouter(services.eventService));
    app.use("/database", databaseRouter(services.databaseService));

    app.use(errorHandler);
    return app;
}
