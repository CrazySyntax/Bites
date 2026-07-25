import { writeFile } from "node:fs/promises";
import type { EndpointRepository } from "../repositories/endpointRepository.js";
import type { EventRepository } from "../repositories/eventRepository.js";
import type { Endpoint, WebhookEvent } from "../types.js";

/**
 * On-disk shape of a database snapshot. `version` stamps the file with the
 * format it was written in, so a future consumer can detect an incompatible one.
 */
interface DatabaseSnapshot {
    version: 1;
    endpoints: Endpoint[];
    events: WebhookEvent[];
}

const SNAPSHOT_VERSION = 1;

export interface DumpResult {
    endpoints: number;
    events: number;
}

/**
 * Persists the whole "database" (both repositories) to a single JSON file, so
 * state can be snapshotted for backup or inspection.
 *
 * The repositories are the durable source of truth; the services hold bounded
 * in-memory working sets written through to them. So a dump reads straight from
 * the repositories, which hold every entity, including dead events not resident
 * in memory.
 */
export class DatabaseService {
    constructor(
        private readonly filePath: string,
        private readonly endpointRepo: EndpointRepository,
        private readonly eventRepo: EventRepository,
    ) {}

    /** Writes an empty snapshot, creating/truncating the file. Called on startup
     * so every process invocation begins from a fresh, empty database file. */
    async initEmptyFile(): Promise<void> {
        await this.writeSnapshot({ version: SNAPSHOT_VERSION, endpoints: [], events: [] });
    }

    /** Serializes the live database to the snapshot file, overwriting it. */
    async dump(): Promise<DumpResult> {
        const endpoints = await this.endpointRepo.dumpAll();
        const events = await this.eventRepo.dumpAll();
        await this.writeSnapshot({ version: SNAPSHOT_VERSION, endpoints, events });
        return { endpoints: endpoints.length, events: events.length };
    }

    private async writeSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
        await writeFile(this.filePath, JSON.stringify(snapshot, null, 2), "utf8");
    }
}
