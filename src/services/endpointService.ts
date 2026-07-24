import { randomBytes, randomUUID } from "node:crypto";
import type { DeliveryManager } from "../delivery/deliveryManager.js";
import { badRequest, notFound } from "../errors.js";
import type { EndpointRepository } from "../repositories/endpointRepository.js";
import type { Endpoint, EndpointStatus } from "../types.js";

export interface UpdateEndpointInput {
    url?: string;
    status?: EndpointStatus;
}

/**
 * Endpoint registration and updates. Changing an endpoint's status also drives
 * the delivery side-effect (pause stops the queue; resume restarts it).
 */
export class EndpointService {
    constructor(
        private readonly endpointRepo: EndpointRepository,
        private readonly deliveryManager: DeliveryManager,
        private readonly now: () => number = Date.now,
    ) {}

    async create(url: string): Promise<Endpoint> {
        assertValidUrl(url);
        const endpoint: Endpoint = {
            id: randomUUID(),
            url,
            secret: randomBytes(32).toString("hex"),
            status: "active",
            createdAt: new Date(this.now()).toISOString(),
        };
        return this.endpointRepo.create(endpoint);
    }

    async getOrThrow(id: string): Promise<Endpoint> {
        const endpoint = await this.endpointRepo.findById(id);
        if (!endpoint) throw notFound("endpoint not found");
        return endpoint;
    }

    async update(id: string, input: UpdateEndpointInput): Promise<Endpoint> {
        if (input.url === undefined && input.status === undefined) {
            throw badRequest("provide at least one of `url` or `status`");
        }
        if (input.url !== undefined) assertValidUrl(input.url);
        if (input.status !== undefined && input.status !== "active" && input.status !== "paused") {
            throw badRequest("`status` must be 'active' or 'paused'");
        }

        const updated = await this.endpointRepo.update(id, input);
        if (!updated) throw notFound("endpoint not found");

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
