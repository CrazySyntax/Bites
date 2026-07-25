import type { Endpoint } from "../../types.js";
import type { EndpointRepository } from "../endpointRepository.js";

/**
 * In-memory endpoint store. The repository is the single source of truth: it
 * stores and returns *copies*, never live references, so the only way to change
 * persisted state is to go back through `create` / `update`. A caller mutating a
 * returned object cannot silently alter the store — which is exactly how a real
 * database behaves, keeping this a faithful drop-in seam.
 *
 * `Endpoint` is flat (all primitive fields), so a shallow copy fully isolates it.
 */
export class InMemoryEndpointRepository implements EndpointRepository {
    private readonly endpoints = new Map<string, Endpoint>();

    async create(endpoint: Endpoint): Promise<Endpoint> {
        this.endpoints.set(endpoint.id, { ...endpoint });
        return { ...endpoint };
    }

    async findById(id: string): Promise<Endpoint | undefined> {
        const found = this.endpoints.get(id);
        return found ? { ...found } : undefined;
    }

    async update(
        id: string,
        patch: Partial<Pick<Endpoint, "url" | "status">>,
    ): Promise<Endpoint | undefined> {
        const existing = this.endpoints.get(id);
        if (!existing) return undefined;
        // A patch key set to `undefined` means "leave unchanged" — never clobber
        // a stored field with undefined. A blind `{ ...existing, ...patch }` would
        // wipe `status` (or `url`) whenever the caller omits it, dropping the
        // field from the record entirely. Only apply fields that carry a value.
        const updated: Endpoint = { ...existing };
        if (patch.url !== undefined) updated.url = patch.url;
        if (patch.status !== undefined) updated.status = patch.status;
        this.endpoints.set(id, updated);
        return { ...updated };
    }

    async count(): Promise<number> {
        return this.endpoints.size;
    }

    async dumpAll(): Promise<Endpoint[]> {
        return Array.from(this.endpoints.values(), (endpoint) => ({ ...endpoint }));
    }
}
