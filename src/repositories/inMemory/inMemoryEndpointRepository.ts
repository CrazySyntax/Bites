import type { Endpoint } from "../../types.js";
import type { EndpointRepository } from "../endpointRepository.js";

export class InMemoryEndpointRepository implements EndpointRepository {
    private readonly endpoints = new Map<string, Endpoint>();

    async create(endpoint: Endpoint): Promise<Endpoint> {
        this.endpoints.set(endpoint.id, endpoint);
        return endpoint;
    }

    async findById(id: string): Promise<Endpoint | undefined> {
        return this.endpoints.get(id);
    }

    async update(
        id: string,
        patch: Partial<Pick<Endpoint, "url" | "status">>,
    ): Promise<Endpoint | undefined> {
        const existing = this.endpoints.get(id);
        if (!existing) return undefined;
        const updated: Endpoint = { ...existing, ...patch };
        this.endpoints.set(id, updated);
        return updated;
    }
}
