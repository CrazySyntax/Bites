import type { DeliveryConfig } from "../config.js";
import type { HttpTransport } from "./httpTransport.js";
import type { EndpointReader, EventStore } from "./stores.js";

/**
 * Everything the delivery engine depends on. Grouped so tests can inject a fake
 * transport, a shrunk config, a deterministic clock, and a fixed rng.
 *
 * Note the engine reads endpoints and reads/persists events through the service
 * layer (`EndpointReader` / `EventStore`), not the repositories directly, so the
 * services own the in-memory working set and remain the single write-through
 * point to the database.
 */
export interface DeliveryDeps {
    endpoints: EndpointReader;
    events: EventStore;
    transport: HttpTransport;
    config: DeliveryConfig;
    /** Wall clock in ms; injectable for deterministic durations/timestamps. */
    now: () => number;
    /** Jitter source for backoff; injectable for deterministic delays. */
    rng: () => number;
}
