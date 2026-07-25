import { randomUUID } from "node:crypto";
import {
    DEFAULT_PAGE_LIMIT,
    MAX_EVENTS_PER_ENDPOINT,
    MAX_IN_MEMORY_EVENTS_PER_ENDPOINT,
    MAX_PAGE_LIMIT,
} from "../config.js";
import type { DeliveryManager } from "../delivery/deliveryManager.js";
import type { EndpointReader, EventStore } from "../delivery/stores.js";
import { badRequest, capacityExceeded, conflict, notFound } from "../errors.js";
import { ConsoleLogger, type Logger } from "../logger.js";
import type {
    EventRepository,
    ListEventsResult,
} from "../repositories/eventRepository.js";
import type { EventStatus, WebhookEvent } from "../types.js";

export interface AcceptEventInput {
    endpointId: string;
    payload: unknown;
    idempotencyKey?: string;
}

export interface AcceptEventResult {
    event: WebhookEvent;
    /** True when an existing event was returned instead of creating a new one. */
    deduplicated: boolean;
}

export interface ListEndpointEventsInput {
    endpointId: string;
    status?: string;
    limit?: number;
    offset?: number;
}

const FILTERABLE_STATUSES: readonly EventStatus[] = ["pending", "delivered", "dead"];

/** Deep copy so callers (and the delivery engine) mutate their own object, not
 * the one held in memory. Mirrors the repository's copy-on-read/write contract. */
function cloneEvent(event: WebhookEvent): WebhookEvent {
    return structuredClone(event);
}

/**
 * Accepts events, exposes their status/history, and re-queues dead ones.
 *
 * Two-level storage: this service owns an in-memory working set (`memory`) and
 * writes every change through to the repository (the "database"). It implements
 * {@link EventStore} so the delivery engine reads and persists events through
 * here rather than touching the repository directly.
 *
 * Bounded working set: to cap the heap, `memory` holds at most
 * {@link MAX_IN_MEMORY_EVENTS_PER_ENDPOINT} non-terminal (`pending`) events
 * **per endpoint** (tracked in `residentByEndpoint`). Once an endpoint is at that
 * limit, a new event is persisted to the database only and not cached. When an
 * endpoint's resident count falls to zero (all its cached events became
 * terminal), the service reloads up to that many recent pending events from the
 * database.
 *
 * Terminal-event rule: when an event becomes terminal — `delivered` (2xx) or
 * `dead` (attempts exhausted) — it is still written to the database (so it can be
 * inspected, listed, and a dead one redelivered later) but is **evicted from
 * memory**: a terminal event should not occupy the process working set. Reads
 * fall back to the database, so `getOrThrow`/`redeliver` still find it.
 */
export class EventService implements EventStore {
    private readonly memory = new Map<string, WebhookEvent>();
    /** endpointId -> set of event ids currently resident in `memory`. */
    private readonly residentByEndpoint = new Map<string, Set<string>>();
    private deliveryManager!: DeliveryManager;
    private readonly logger: Logger = new ConsoleLogger();

    constructor(
        private readonly eventRepo: EventRepository,
        private readonly endpoints: EndpointReader,
        private readonly now: () => number = Date.now,
    ) {}

    /** Wire the delivery manager after construction (breaks the DI cycle). */
    setDeliveryManager(deliveryManager: DeliveryManager): void {
        this.deliveryManager = deliveryManager;
    }

    /** The set of event ids resident in memory for an endpoint (created lazily). */
    private residentIds(endpointId: string): Set<string> {
        let ids = this.residentByEndpoint.get(endpointId);
        if (!ids) {
            ids = new Set<string>();
            this.residentByEndpoint.set(endpointId, ids);
        }
        return ids;
    }

    /**
     * Admit an event into the working set, or update it if already resident,
     * respecting the per-endpoint cap. A non-resident event is dropped (kept in
     * the database only) once the endpoint is at capacity. Returns whether the
     * event is resident afterwards.
     */
    private cachePut(event: WebhookEvent): boolean {
        const ids = this.residentIds(event.endpointId);
        if (!ids.has(event.id) && ids.size >= MAX_IN_MEMORY_EVENTS_PER_ENDPOINT) {
            return false; // at cap and not already cached -> database only
        }
        this.memory.set(event.id, cloneEvent(event));
        ids.add(event.id);
        return true;
    }

    /** Remove an event from the working set (no-op if it was not resident). */
    private cacheEvict(event: WebhookEvent): void {
        if (this.memory.delete(event.id)) {
            this.residentByEndpoint.get(event.endpointId)?.delete(event.id);
        }
    }

    /**
     * If an endpoint has no resident events left, repopulate the working set with
     * up to the per-endpoint cap of recent pending events from the database.
     */
    private async reloadIfEmpty(endpointId: string): Promise<void> {
        if (this.residentIds(endpointId).size > 0) return;

        const recent = await this.eventRepo.findRecentActiveByEndpoint(
            endpointId,
            MAX_IN_MEMORY_EVENTS_PER_ENDPOINT,
        );
        const ids = this.residentIds(endpointId);
        for (const event of recent) {
            this.memory.set(event.id, event); // already a fresh copy from the repo
            ids.add(event.id);
        }
    }

    /**
     * Accepts an event for asynchronous delivery. Returns 202-worthy result for a
     * fresh event, or the existing event (deduplicated) when the idempotency key
     * has been seen before.
     *
     * The create + index writes are intentionally free of an intervening `await`
     * so that two concurrent same-key requests cannot both pass the existence
     * check (single-threaded Node guarantees atomicity of the sync section).
     */
    async accept(input: AcceptEventInput): Promise<AcceptEventResult> {
        const { endpointId, payload, idempotencyKey } = input;

        if (payload === undefined || payload === null || typeof payload !== "object") {
            throw badRequest("`payload` must be a JSON object");
        }

        const endpoint = await this.endpoints.findById(endpointId);
        if (!endpoint) this.endpointNotFound(endpointId);

        if (idempotencyKey) {
            const existing = await this.eventRepo.findByIdempotencyKey(endpointId, idempotencyKey);
            if (existing) return { event: existing, deduplicated: true };
        }

        // Capacity guard against unbounded growth, measured against the durable
        // store (survives dead-event eviction from memory). Checked after the
        // idempotency lookup so a deduplicated request never trips the limit.
        // See README "Assumptions".
        if ((await this.eventRepo.countByEndpoint(endpointId)) >= MAX_EVENTS_PER_ENDPOINT) {
            throw capacityExceeded(`event limit reached for endpoint (max ${MAX_EVENTS_PER_ENDPOINT})`);
        }

        const event: WebhookEvent = {
            id: randomUUID(),
            endpointId,
            payload,
            rawPayload: JSON.stringify(payload),
            status: "pending",
            attempts: [],
            attemptCount: 0,
            idempotencyKey,
            createdAt: new Date(this.now()).toISOString(),
        };

        // Write through to the database (durable), then admit to the working set
        // only if the endpoint is under its resident cap — beyond it the event
        // lives in the database only until the endpoint's cache drains.
        await this.eventRepo.create(event);
        this.cachePut(event);
        this.logger.info("event.created", event);
        if (idempotencyKey) {
            await this.eventRepo.saveIdempotencyKey(endpointId, idempotencyKey, event.id);
        }

        // Enqueue after persistence so GET /events/:id is consistent immediately.
        this.deliveryManager.enqueue(endpointId, event.id);

        return { event, deduplicated: false };
    }

    /** Memory-first read with database fallback (implements EventStore). A dead
     * event, evicted from memory, is resolved from the database here. */
    async findById(id: string): Promise<WebhookEvent | undefined> {
        const cached = this.memory.get(id);
        if (cached) return cloneEvent(cached);

        const stored = await this.eventRepo.findById(id);
        return stored ? cloneEvent(stored) : undefined;
    }

    /**
     * Persists a mutated event (implements EventStore). Always reflects the
     * change to the database; then keeps memory as the live working set — except
     * a terminal event (`dead` or `delivered`) is evicted from memory (it lives
     * only in the database, where it can still be read/listed/redelivered). When
     * evicting a terminal event empties an endpoint's working set, the endpoint is
     * repopulated from the database (up to the per-endpoint cap).
     */
    async save(event: WebhookEvent): Promise<WebhookEvent> {
        await this.eventRepo.save(event);
        this.logger.info("event.changed", event);

        if (event.status === "dead" || event.status === "delivered") {
            this.cacheEvict(event);
            await this.reloadIfEmpty(event.endpointId);
        } else {
            // A non-dead event already resident is refreshed; one that overflowed
            // the cap on creation stays database-only (cachePut is a no-op at cap).
            this.cachePut(event);
        }

        return cloneEvent(event);
    }

    /** Number of events currently held in the process working set (memory). An
     * operational metric; excludes dead events, which are evicted to the DB. */
    inMemoryCount(): number {
        return this.memory.size;
    }

    /** Number of events resident in memory for a single endpoint (≤ the
     * per-endpoint cap). An operational metric used to observe the bounded cache. */
    inMemoryCountForEndpoint(endpointId: string): number {
        return this.residentByEndpoint.get(endpointId)?.size ?? 0;
    }

    async getOrThrow(id: string): Promise<WebhookEvent> {
        const event = await this.findById(id);
        if (!event) throw notFound("event not found");
        return event;
    }

    /** Log which endpoint was missing (aids debugging a bad endpointId in a
     * request) and throw the 404. `never` return lets callers use it as a throw. */
    private endpointNotFound(endpointId: string): never {
        this.logger.error("endpoint.notFound", { endpointId });
        throw notFound("endpoint not found");
    }

    async listForEndpoint(input: ListEndpointEventsInput): Promise<ListEventsResult> {
        const endpoint = await this.endpoints.findById(input.endpointId);
        if (!endpoint) this.endpointNotFound(input.endpointId);

        const status = this.parseStatusFilter(input.status);
        const limit = this.parseLimit(input.limit);
        const offset = this.parseOffset(input.offset);

        // List from the database: it holds every event including dead ones, which
        // are not kept in memory.
        return this.eventRepo.list({ endpointId: input.endpointId, status, limit, offset });
    }

    /**
     * Re-queues a dead event. The attempt counter resets so the event gets a
     * fresh set of attempts, but the historical attempts are preserved. It is
     * re-inserted at the tail of the queue (it already lost its ordering slot).
     * Reading via `findById` falls back to the database, since a dead event has
     * been evicted from memory; `save` re-admits it to the working set.
     */
    async redeliver(id: string): Promise<WebhookEvent> {
        const event = await this.getOrThrow(id);
        if (event.status !== "dead") {
            throw conflict("only dead events can be redelivered");
        }

        event.status = "pending";
        event.attemptCount = 0;
        await this.save(event);

        this.deliveryManager.enqueue(event.endpointId, event.id);
        return event;
    }

    private parseStatusFilter(status?: string): EventStatus | undefined {
        if (status === undefined) return undefined;
        if (!FILTERABLE_STATUSES.includes(status as EventStatus)) {
            throw badRequest("`status` must be one of pending, delivered, dead");
        }
        return status as EventStatus;
    }

    private parseLimit(limit?: number): number {
        if (limit === undefined) return DEFAULT_PAGE_LIMIT;
        if (!Number.isInteger(limit) || limit < 1) {
            throw badRequest("`limit` must be a positive integer");
        }
        return Math.min(limit, MAX_PAGE_LIMIT);
    }

    private parseOffset(offset?: number): number {
        if (offset === undefined) return 0;
        if (!Number.isInteger(offset) || offset < 0) {
            throw badRequest("`offset` must be a non-negative integer");
        }
        return offset;
    }
}
