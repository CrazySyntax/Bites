import { readFile, writeFile } from "node:fs/promises";
import type { EndpointRepository } from "../repositories/endpointRepository.js";
import type { EventRepository } from "../repositories/eventRepository.js";
import type { Endpoint, WebhookEvent } from "../types.js";
import type { EndpointService } from "./endpointService.js";
import type { EventService } from "./eventService.js";

/**
 * On-disk shape of a database snapshot. `version` guards against loading a file
 * written by an incompatible future format.
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

export interface LoadResult {
    endpoints: number;
    events: number;
}

/**
 * Persists and restores the whole "database" (both repositories) to and from a
 * single JSON file, so state survives a process crash.
 *
 * The repositories are the durable source of truth; the services hold bounded
 * in-memory working sets written through to them. So a dump reads straight from
 * the repositories (they hold every entity, including dead events not resident
 * in memory), and a load restores the repositories then rehydrates the services'
 * working sets — re-queuing pending events so delivery resumes.
 */
export class DatabaseService {
    constructor(
        private readonly filePath: string,
        private readonly endpointRepo: EndpointRepository,
        private readonly eventRepo: EventRepository,
        private readonly endpointService: EndpointService,
        private readonly eventService: EventService,
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

    /**
     * Restores the database from the snapshot file: loads both repositories, then
     * rehydrates the services' working sets. `EndpointService` reloads first so
     * paused endpoints have their queues paused before `EventService` re-queues
     * restored pending events.
     */
    async load(): Promise<LoadResult> {
        const snapshot = await this.readSnapshot();

        await this.endpointRepo.loadAll(snapshot.endpoints);
        await this.eventRepo.loadAll(snapshot.events);

        await this.endpointService.reload();
        await this.eventService.reload();

        return { endpoints: snapshot.endpoints.length, events: snapshot.events.length };
    }

    private async writeSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
        await writeFile(this.filePath, JSON.stringify(snapshot, null, 2), "utf8");
    }

    private async readSnapshot(): Promise<DatabaseSnapshot> {
        const raw = await readFile(this.filePath, "utf8");
        const parsed = JSON.parse(raw) as DatabaseSnapshot;

        if (parsed?.version !== SNAPSHOT_VERSION) {
            throw new Error(`unsupported snapshot version: ${parsed?.version}`);
        }
        if (!Array.isArray(parsed.endpoints) || !Array.isArray(parsed.events)) {
            throw new Error("malformed snapshot: `endpoints` and `events` must be arrays");
        }
        return parsed;
    }
}
