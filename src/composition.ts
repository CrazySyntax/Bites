import type { AppServices } from "./app.js";
import { DATABASE_FILE, defaultDeliveryConfig, type DeliveryConfig } from "./config.js";
import { DeliveryManager } from "./delivery/deliveryManager.js";
import type { DeliveryDeps } from "./delivery/deliveryDeps.js";
import { FetchTransport, type HttpTransport } from "./delivery/httpTransport.js";
import { InMemoryEndpointRepository } from "./repositories/inMemory/inMemoryEndpointRepository.js";
import { InMemoryEventRepository } from "./repositories/inMemory/inMemoryEventRepository.js";
import { DatabaseService } from "./services/databaseService.js";
import { EndpointService } from "./services/endpointService.js";
import { EventService } from "./services/eventService.js";

export interface CompositionOverrides {
    transport?: HttpTransport;
    config?: DeliveryConfig;
    now?: () => number;
    rng?: () => number;
    /** Snapshot file for the dump/load endpoints (defaults to `DATABASE_FILE`). */
    databaseFile?: string;
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
    const now = overrides.now ?? Date.now;

    // Services own the in-memory working set and are the delivery engine's
    // storage seam. Build them first, then the manager (which reads/persists
    // through the services), then close the cycle with setter injection.
    const endpointService = new EndpointService(endpointRepo, now);
    const eventService = new EventService(eventRepo, endpointService, now);

    const deliveryDeps: DeliveryDeps = {
        endpoints: endpointService,
        events: eventService,
        transport: overrides.transport ?? new FetchTransport(),
        config: overrides.config ?? defaultDeliveryConfig,
        now,
        rng: overrides.rng ?? Math.random,
    };

    const deliveryManager = new DeliveryManager(deliveryDeps);
    endpointService.setDeliveryManager(deliveryManager);
    eventService.setDeliveryManager(deliveryManager);

    const databaseService = new DatabaseService(
        overrides.databaseFile ?? DATABASE_FILE,
        endpointRepo,
        eventRepo,
        endpointService,
        eventService,
    );

    return { endpointService, eventService, databaseService, deliveryManager };
}
