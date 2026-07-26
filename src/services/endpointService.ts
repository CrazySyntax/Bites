import { randomBytes, randomUUID } from "node:crypto";
import type { DeliveryManager } from "../delivery/deliveryManager.js";
import type { EndpointReader } from "../delivery/stores.js";
import { badRequest, notFound } from "../errors.js";
import { ConsoleLogger, redactEndpoint, type Logger } from "../logger.js";
import type { EndpointRepository } from "../repositories/endpointRepository.js";
import type { Endpoint, EndpointStatus } from "../types.js";

export interface UpdateEndpointInput {
    url?: string;
    status?: EndpointStatus;
}

/**
 * Endpoint registration and updates.
 *
 * Two-level storage: this service owns the in-memory working set (`memory`) and
 * writes every change through to the repository (the "database"). Reads are
 * served from memory first, falling back to the database. Endpoints are never
 * evicted (they have no terminal state), so the two levels stay in sync.
 *
 * Implements {@link EndpointReader} so the delivery engine can resolve an
 * endpoint's url + secret through this service rather than the repository.
 *
 * Changing an endpoint's status also drives the delivery side effect (pause
 * stops the queue; resume restarts it). The `DeliveryManager` is injected after
 * construction (`setDeliveryManager`) to break the service<->engine cycle.
 */
export class EndpointService implements EndpointReader {
    private readonly memory = new Map<string, Endpoint>();
    private deliveryManager!: DeliveryManager;
    private readonly logger: Logger = new ConsoleLogger();

    constructor(
        private readonly endpointRepo: EndpointRepository,
        private readonly now: () => number = Date.now,
    ) {}

    /** Wire the delivery manager after construction (breaks the DI cycle). */
    setDeliveryManager(deliveryManager: DeliveryManager): void {
        this.deliveryManager = deliveryManager;
    }

    async create(url: string): Promise<Endpoint> {
        assertValidUrl(url);

        const endpoint: Endpoint = {
            id: randomUUID(),
            url,
            secret: randomBytes(32).toString("hex"),
            status: "active",
            createdAt: new Date(this.now()).toISOString(),
        };

        // Write through to both levels: memory (working set) + database.
        this.memory.set(endpoint.id, { ...endpoint });
        await this.endpointRepo.create(endpoint);
        this.logger.info("endpoint.created", redactEndpoint(endpoint));
        return endpoint;
    }

    /** Memory-first read with database fallback (implements EndpointReader). */
    async findById(id: string): Promise<Endpoint | undefined> {
        const cached = this.memory.get(id);
        if (cached) return { ...cached };

        const stored = await this.endpointRepo.findById(id);
        if (stored) this.memory.set(id, { ...stored });
        return stored;
    }

    async getOrThrow(id: string): Promise<Endpoint> {
        const endpoint = await this.findById(id);
        if (!endpoint) this.endpointNotFound(id);
        return endpoint;
    }

    /** Log which endpoint was missing (aids debugging a bad id in a request) and
     * throw the 404. `never` return lets callers use it as a throw. */
    private endpointNotFound(id: string): never {
        this.logger.error("endpoint.notFound", { endpointId: id });
        throw notFound("endpoint not found");
    }

    async update(id: string, input: UpdateEndpointInput): Promise<Endpoint> {
        if (input.url === undefined && input.status === undefined) {
            throw badRequest("provide at least one of `url` or `status`");
        }
        if (input.url !== undefined) assertValidUrl(input.url);
        if (input.status !== undefined && input.status !== "active" && input.status !== "paused") {
            throw badRequest("`status` must be 'active' or 'paused'");
        }

        // Reflect the change in the database, then mirror it into memory so both
        // levels agree.
        const updated = await this.endpointRepo.update(id, input);
        if (!updated) this.endpointNotFound(id);
        this.memory.set(id, { ...updated });
        this.logger.info("endpoint.updated", redactEndpoint(updated));

        // Drive delivery to match the new status.
        if (input.status === "paused") this.deliveryManager.pause(id);
        else if (input.status === "active") this.deliveryManager.resume(id);

        return updated;
    }
}

function assertValidUrl(url: string): void {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw badRequest("`url` must be a valid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw badRequest("`url` must use http or https");
    }
}
