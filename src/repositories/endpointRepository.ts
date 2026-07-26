import type { Endpoint } from "../types.js";

/**
 * Persistence boundary for endpoints. The in-memory implementation lives in
 * `inMemory/`; swapping in a real database means implementing this interface.
 *
 * Methods are async (return Promises) so a DB-backed implementation is a
 * drop-in replacement without changing any callers.
 */
export interface EndpointRepository {
    create(endpoint: Endpoint): Promise<Endpoint>;
    findById(id: string): Promise<Endpoint | undefined>;
    update(id: string, patch: Partial<Pick<Endpoint, "url" | "status">>): Promise<Endpoint | undefined>;

    /** Export every endpoint (used to snapshot the database to a file). */
    dumpAll(): Promise<Endpoint[]>;
}
