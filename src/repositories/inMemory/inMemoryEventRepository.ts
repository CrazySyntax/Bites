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

export class InMemoryEventRepository implements EventRepository {
    private readonly events = new Map<string, WebhookEvent>();
    /** endpointId -> event ids in insertion (chronological) order. */
    private readonly byEndpoint = new Map<string, string[]>();
    /** "endpointId:idempotencyKey" -> eventId. */
    private readonly idempotency = new Map<string, string>();

    async create(event: WebhookEvent): Promise<WebhookEvent> {
        this.events.set(event.id, event);
        const ids = this.byEndpoint.get(event.endpointId) ?? [];
        ids.push(event.id);
        this.byEndpoint.set(event.endpointId, ids);
        return event;
    }

    async findById(id: string): Promise<WebhookEvent | undefined> {
        return this.events.get(id);
    }

    async save(event: WebhookEvent): Promise<WebhookEvent> {
        this.events.set(event.id, event);
        return event;
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
            matched.push(event);
        }

        const page = matched.slice(offset, offset + limit);
        return { events: page, total: matched.length, limit, offset };
    }

    async findByIdempotencyKey(
        endpointId: string,
        key: string,
    ): Promise<WebhookEvent | undefined> {
        const eventId = this.idempotency.get(this.idempotencyIndexKey(endpointId, key));
        return eventId ? this.events.get(eventId) : undefined;
    }

    async saveIdempotencyKey(endpointId: string, key: string, eventId: string): Promise<void> {
        this.idempotency.set(this.idempotencyIndexKey(endpointId, key), eventId);
    }

    async countByEndpoint(endpointId: string): Promise<number> {
        return (this.byEndpoint.get(endpointId) ?? []).length;
    }

    private idempotencyIndexKey(endpointId: string, key: string): string {
        return `${endpointId}:${key}`;
    }
}
