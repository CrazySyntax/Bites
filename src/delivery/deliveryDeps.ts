import type { DeliveryConfig } from "../config.js";
import type { EndpointRepository } from "../repositories/endpointRepository.js";
import type { EventRepository } from "../repositories/eventRepository.js";
import type { HttpTransport } from "./httpTransport.js";

/**
 * Everything the delivery engine depends on. Grouped so tests can inject a fake
 * transport, a shrunk config, a deterministic clock, and a fixed rng.
 */
export interface DeliveryDeps {
    endpointRepo: EndpointRepository;
    eventRepo: EventRepository;
    transport: HttpTransport;
    config: DeliveryConfig;
    /** Wall clock in ms; injectable for deterministic durations/timestamps. */
    now: () => number;
    /** Jitter source for backoff; injectable for deterministic delays. */
    rng: () => number;
}
