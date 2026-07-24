import type { AppServices } from "./app.js";
import { defaultDeliveryConfig, type DeliveryConfig } from "./config.js";
import { DeliveryManager } from "./delivery/deliveryManager.js";
import type { DeliveryDeps } from "./delivery/deliveryDeps.js";
import { FetchTransport, type HttpTransport } from "./delivery/httpTransport.js";
import { InMemoryEndpointRepository } from "./repositories/inMemory/inMemoryEndpointRepository.js";
import { InMemoryEventRepository } from "./repositories/inMemory/inMemoryEventRepository.js";
import { EndpointService } from "./services/endpointService.js";
import { EventService } from "./services/eventService.js";

export interface CompositionOverrides {
    transport?: HttpTransport;
    config?: DeliveryConfig;
    now?: () => number;
    rng?: () => number;
}

export interface Composition extends AppServices {
    deliveryManager: DeliveryManager;
}

/**
 * Wires the object graph: in-memory repositories, the delivery engine, and the
 * services. Overrides let tests swap in a fake transport, a shrunk config, a
 * deterministic clock, or a fixed rng. The default config/transport are used
 * by the production entrypoint.
 */
export function createComposition(overrides: CompositionOverrides = {}): Composition {
    const endpointRepo = new InMemoryEndpointRepository();
    const eventRepo = new InMemoryEventRepository();

    const deliveryDeps: DeliveryDeps = {
        endpointRepo,
        eventRepo,
        transport: overrides.transport ?? new FetchTransport(),
        config: overrides.config ?? defaultDeliveryConfig,
        now: overrides.now ?? Date.now,
        rng: overrides.rng ?? Math.random,
    };

    const deliveryManager = new DeliveryManager(deliveryDeps);
    const endpointService = new EndpointService(endpointRepo, deliveryManager, deliveryDeps.now);
    const eventService = new EventService(eventRepo, endpointRepo, deliveryManager, deliveryDeps.now);

    return { endpointService, eventService, deliveryManager };
}
