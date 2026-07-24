import { randomUUID } from "node:crypto";
import { DEFAULT_PAGE_LIMIT, MAX_EVENTS_PER_ENDPOINT, MAX_PAGE_LIMIT } from "../config.js";
import type { DeliveryManager } from "../delivery/deliveryManager.js";
import { badRequest, capacityExceeded, conflict, notFound } from "../errors.js";
import type { EndpointRepository } from "../repositories/endpointRepository.js";
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

export class EventService {
    constructor(
        private readonly eventRepo: EventRepository,
        private readonly endpointRepo: EndpointRepository,
        private readonly deliveryManager: DeliveryManager,
        private readonly now: () => number = Date.now,
    ) {}

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

        const endpoint = await this.endpointRepo.findById(endpointId);
        if (!endpoint) throw notFound("endpoint not found");

        if (idempotencyKey) {
            const existing = await this.eventRepo.findByIdempotencyKey(endpointId, idempotencyKey);
            if (existing) return { event: existing, deduplicated: true };
        }

        // Capacity guard against unbounded in-memory growth. Checked after the
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

        await this.eventRepo.create(event);
        if (idempotencyKey) {
            await this.eventRepo.saveIdempotencyKey(endpointId, idempotencyKey, event.id);
        }

        // Enqueue after persistence so GET /events/:id is consistent immediately.
        this.deliveryManager.enqueue(endpointId, event.id);

        return { event, deduplicated: false };
    }

    async getOrThrow(id: string): Promise<WebhookEvent> {
        const event = await this.eventRepo.findById(id);
        if (!event) throw notFound("event not found");
        return event;
    }

    async listForEndpoint(input: ListEndpointEventsInput): Promise<ListEventsResult> {
        const endpoint = await this.endpointRepo.findById(input.endpointId);
        if (!endpoint) throw notFound("endpoint not found");

        const status = this.parseStatusFilter(input.status);
        const limit = this.parseLimit(input.limit);
        const offset = this.parseOffset(input.offset);

        return this.eventRepo.list({ endpointId: input.endpointId, status, limit, offset });
    }

    /**
     * Re-queues a dead event. The attempt counter resets so the event gets a
     * fresh set of attempts, but the historical attempts are preserved. It is
     * re-inserted at the tail of the queue (it already lost its ordering slot).
     */
    async redeliver(id: string): Promise<WebhookEvent> {
        const event = await this.getOrThrow(id);
        if (event.status !== "dead") {
            throw conflict("only dead events can be redelivered");
        }

        event.status = "pending";
        event.attemptCount = 0;
        await this.eventRepo.save(event);

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
