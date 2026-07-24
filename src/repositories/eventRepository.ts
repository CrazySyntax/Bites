import type { EventStatus, WebhookEvent } from "../types.js";

export interface ListEventsQuery {
    endpointId: string;
    /** Filter by lifecycle status. `pending` also matches in-flight `delivering`. */
    status?: EventStatus;
    limit: number;
    offset: number;
}

export interface ListEventsResult {
    events: WebhookEvent[];
    total: number;
    limit: number;
    offset: number;
}

/**
 * Persistence boundary for events. The in-memory implementation additionally
 * maintains a per-endpoint insertion-ordered index (for newest-first listing)
 * and an idempotency index; a real store would use indexed columns instead.
 */
export interface EventRepository {
    create(event: WebhookEvent): Promise<WebhookEvent>;
    findById(id: string): Promise<WebhookEvent | undefined>;
    /**
     * Persist a mutated event. Callers mutate the object they hold and call this
     * to signal the change; a real store would translate this into an UPDATE.
     */
    save(event: WebhookEvent): Promise<WebhookEvent>;
    list(query: ListEventsQuery): Promise<ListEventsResult>;

    /** Look up an event previously created with the given idempotency key. */
    findByIdempotencyKey(endpointId: string, key: string): Promise<WebhookEvent | undefined>;
    /** Record the mapping from an idempotency key to an event id. */
    saveIdempotencyKey(endpointId: string, key: string, eventId: string): Promise<void>;

    /** Number of events belonging to an endpoint (used to enforce the capacity limit). */
    countByEndpoint(endpointId: string): Promise<number>;
}
