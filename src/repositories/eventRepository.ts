import type { EventStatus, WebhookEvent } from "../types.js";

export interface ListEventsQuery {
    endpointId: string;
    /** Filter by lifecycle status (`pending` | `delivered` | `dead`). */
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
    findByIdempotencyKey(key: string): Promise<WebhookEvent | undefined>;
    /** Record the mapping from an idempotency key to an event id. */
    saveIdempotencyKey(key: string, eventId: string): Promise<void>;

    /**
     * The most recent pending (non-terminal) events for an endpoint, newest
     * first, capped at `limit`. Used to repopulate the service's in-memory
     * working set from the database when it empties for that endpoint; terminal
     * events (delivered/dead) stay in the database only.
     */
    findRecentActiveByEndpoint(endpointId: string, limit: number): Promise<WebhookEvent[]>;

    /**
     * Export every event in creation order (used to snapshot the database to a
     * file). The per-endpoint order and idempotency indexes are derivable from
     * the events themselves, so they are not part of the snapshot.
     */
    dumpAll(): Promise<WebhookEvent[]>;
}
