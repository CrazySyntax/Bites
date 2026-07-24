import type { DeliveryConfig } from "../src/config.js";
import { DeliveryManager } from "../src/delivery/deliveryManager.js";
import type { DeliveryDeps } from "../src/delivery/deliveryDeps.js";
import type {
    HttpTransport,
    TransportRequest,
    TransportResponse,
} from "../src/delivery/httpTransport.js";
import { InMemoryEndpointRepository } from "../src/repositories/inMemory/inMemoryEndpointRepository.js";
import { InMemoryEventRepository } from "../src/repositories/inMemory/inMemoryEventRepository.js";
import { EndpointService } from "../src/services/endpointService.js";
import { EventService } from "../src/services/eventService.js";

/**
 * A scripted HTTP transport for tests. Records every request in order and
 * delegates the response to a caller-supplied responder, so a test can make an
 * endpoint succeed, fail with a status, throw, or hang until its timeout aborts
 * it — all without touching the network.
 */
export type Responder = (
    req: TransportRequest,
    callIndex: number,
) => Promise<TransportResponse>;

export class FakeTransport implements HttpTransport {
    /** Snapshot of every request received, in call order. */
    readonly calls: TransportRequest[] = [];

    constructor(private responder: Responder) {}

    setResponder(responder: Responder): void {
        this.responder = responder;
    }

    async send(req: TransportRequest): Promise<TransportResponse> {
        this.calls.push({ ...req });
        return this.responder(req, this.calls.length);
    }
}

/** Rejects only when the request's timeout aborts the signal (simulates a slow endpoint). */
export function respondNever(req: TransportRequest): Promise<TransportResponse> {
    return new Promise((_resolve, reject) => {
        if (req.signal.aborted) {
            reject(new Error("aborted"));
            return;
        }
        req.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
}

/** Fast, deterministic config for tests: tiny backoff, no jitter, short timeout. */
export const testConfig: DeliveryConfig = {
    maxAttempts: 5,
    timeoutMs: 100,
    backoffBaseMs: 1,
    backoffFactor: 2,
    backoffMaxMs: 20,
};

export interface Harness {
    endpointRepo: InMemoryEndpointRepository;
    eventRepo: InMemoryEventRepository;
    transport: FakeTransport;
    manager: DeliveryManager;
    endpointService: EndpointService;
    eventService: EventService;
}

/**
 * Builds a fully-wired object graph with in-memory repos + a fake transport,
 * for testing the delivery engine and services directly.
 */
export function createHarness(options: {
    responder: Responder;
    config?: DeliveryConfig;
    rng?: () => number;
}): Harness {
    const endpointRepo = new InMemoryEndpointRepository();
    const eventRepo = new InMemoryEventRepository();
    const transport = new FakeTransport(options.responder);

    const deps: DeliveryDeps = {
        endpointRepo,
        eventRepo,
        transport,
        config: options.config ?? testConfig,
        now: Date.now,
        rng: options.rng ?? (() => 0), // deterministic backoff by default
    };

    const manager = new DeliveryManager(deps);
    const endpointService = new EndpointService(endpointRepo, manager, deps.now);
    const eventService = new EventService(eventRepo, endpointRepo, manager, deps.now);

    return { endpointRepo, eventRepo, transport, manager, endpointService, eventService };
}
