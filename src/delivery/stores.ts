import type { Endpoint, WebhookEvent } from "../types.js";

/**
 * The narrow storage seams the delivery engine depends on. They are implemented
 * by the services (`EndpointService` / `EventService`), NOT by the repositories
 * directly, so the engine reads and persists through the in-memory working set
 * and the services stay the single write-through point to the "database".
 *
 * Keeping these interfaces minimal (only what the queue actually calls) also
 * documents the engine's true dependency surface and avoids handing it the full
 * repository API.
 */

/** Read-only endpoint access the engine needs to sign + address a delivery. */
export interface EndpointReader {
    findById(id: string): Promise<Endpoint | undefined>;
}

/** Read + persist access the engine needs to record attempts and status. */
export interface EventStore {
    findById(id: string): Promise<WebhookEvent | undefined>;
    save(event: WebhookEvent): Promise<WebhookEvent>;
}
