import type { EventStatus, WebhookEvent } from "../../types.js";
import type {
    EventRepository,
    ListEventsQuery,
    ListEventsResult,
} from "../eventRepository.js";

/**
 * Returns true if an event with `actual` status should be included when the
 * caller filters by `filter`. The event lifecycle and the public filter share
 * the same three values (pending | delivered | dead), so this is a direct match.
 */
function matchesStatusFilter(actual: EventStatus, filter: EventStatus): boolean {
    return actual === filter;
}

/**
 * Deep copy of an event, isolating it from the store. `WebhookEvent` has a
 * nested `attempts[]` array (mutated via `.push()` during delivery) and an
 * arbitrary JSON `payload`, so a shallow spread is not enough — those would
 * still be shared references.
 */
function cloneEvent(event: WebhookEvent): WebhookEvent {
    return structuredClone(event);
}

/**
 * In-memory event store. The repository is the single source of truth: it
 * stores and returns deep *copies*, never live references, so the only way to
 * change persisted state is to go back through `create` / `save`. A caller
 * mutating a returned event (e.g. the delivery loop pushing an attempt) cannot
 * silently alter the store — the change lands only when it calls `save`. This is
 * how a real database behaves, keeping the repository a faithful drop-in seam.
 */
export class InMemoryEventRepository implements EventRepository {
    private readonly events = new Map<string, WebhookEvent>();
    /** endpointId -> event ids in insertion (chronological) order. */
    private readonly byEndpoint = new Map<string, string[]>();
    /** "endpointId:idempotencyKey" -> eventId. */
    private readonly idempotency = new Map<string, string>();

    async create(event: WebhookEvent): Promise<WebhookEvent> {
        this.events.set(event.id, cloneEvent(event));
        const ids = this.byEndpoint.get(event.endpointId) ?? [];
        ids.push(event.id);
        this.byEndpoint.set(event.endpointId, ids);
        return cloneEvent(event);
    }

    async findById(id: string): Promise<WebhookEvent | undefined> {
        const found = this.events.get(id);
        return found ? cloneEvent(found) : undefined;
    }

    async save(event: WebhookEvent): Promise<WebhookEvent> {
        this.events.set(event.id, cloneEvent(event));
        return cloneEvent(event);
    }

    async list(query: ListEventsQuery): Promise<ListEventsResult> {
        const { endpointId, status, limit, offset } = query;
        const ids = this.byEndpoint.get(endpointId) ?? [];

        // Newest first: walk the insertion-ordered index in reverse.
        const matched: WebhookEvent[] = [];
        for (let i = ids.length - 1; i >= 0; i--) {
            const event = this.events.get(ids[i]);
            if (!event) continue;
            if (status && !matchesStatusFilter(event.status, status)) continue;
            matched.push(cloneEvent(event));
        }

        const page = matched.slice(offset, offset + limit);
        return { events: page, total: matched.length, limit, offset };
    }

    async findByIdempotencyKey(
        key: string,
    ): Promise<WebhookEvent | undefined> {
        const eventId = this.idempotency.get(key);
        const found = eventId ? this.events.get(eventId) : undefined;
        return found ? cloneEvent(found) : undefined;
    }

    async saveIdempotencyKey(key: string, eventId: string): Promise<void> {
        this.idempotency.set(key, eventId);
    }

    async countByEndpoint(endpointId: string): Promise<number> {
        return (this.byEndpoint.get(endpointId) ?? []).length;
    }

    async findRecentActiveByEndpoint(endpointId: string, limit: number): Promise<WebhookEvent[]> {
        const ids = this.byEndpoint.get(endpointId) ?? [];

        // Newest first: walk the insertion-ordered index in reverse, keeping only
        // pending (non-terminal) events, until we have `limit` of them. Terminal
        // events (delivered/dead) live in the database only and are not reloaded.
        const recent: WebhookEvent[] = [];
        for (let i = ids.length - 1; i >= 0 && recent.length < limit; i--) {
            const event = this.events.get(ids[i]);
            if (!event || event.status !== "pending") continue;
            recent.push(cloneEvent(event));
        }
        return recent;
    }

    async dumpAll(): Promise<WebhookEvent[]> {
        // Creation order across all endpoints: walk each endpoint's insertion
        // index. (Cross-endpoint order is not significant.)
        const all: WebhookEvent[] = [];
        for (const ids of this.byEndpoint.values()) {
            for (const id of ids) {
                const event = this.events.get(id);
                if (event) all.push(cloneEvent(event));
            }
        }
        return all;
    }

}
