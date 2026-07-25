import { Router } from "express";
import type { DatabaseService } from "../services/databaseService.js";

/**
 * Database snapshot route. Express 5 forwards rejected promises from async
 * handlers to the error middleware, so handlers just `await` and throw.
 *
 * The snapshot file location is fixed server-side (see `DATABASE_FILE`); the
 * route does not take a path from the client.
 */
export function databaseRouter(databaseService: DatabaseService): Router {
    const router = Router();

    // POST /database/dump — write the live database to the snapshot file.
    router.post("/dump", async (_req, res) => {
        const { endpoints, events } = await databaseService.dump();
        res.json({ dumped: true, endpoints, events });
    });

    return router;
}
