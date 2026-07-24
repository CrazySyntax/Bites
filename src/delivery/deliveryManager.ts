import type { DeliveryDeps } from "./deliveryDeps.js";
import { EndpointQueue } from "./endpointQueue.js";

/**
 * Owns one {@link EndpointQueue} per endpoint and routes lifecycle operations
 * to the right queue. Queues are created lazily on first use.
 *
 * Because each endpoint gets its own queue and worker loop, different endpoints
 * are delivered concurrently and a stuck endpoint only blocks its own queue.
 */
export class DeliveryManager {
    private readonly queues = new Map<string, EndpointQueue>();

    constructor(private readonly deps: DeliveryDeps) {}

    /** Queue an event for delivery (appends to that endpoint's FIFO). */
    enqueue(endpointId: string, eventId: string): void {
        this.queueFor(endpointId).enqueue(eventId);
    }

    pause(endpointId: string): void {
        // Create-if-absent so pausing an endpoint before any event has been
        // enqueued is still remembered when its first event arrives.
        this.queueFor(endpointId).pause();
    }

    resume(endpointId: string): void {
        // Create-if-absent so a resume before any event still readies the queue.
        this.queueFor(endpointId).resume();
    }

    /** Await quiescence of one endpoint's queue (used in tests). */
    onIdle(endpointId: string): Promise<void> {
        return this.queues.get(endpointId)?.onIdle() ?? Promise.resolve();
    }

    /** Pause every queue and abort in-flight requests (process shutdown). */
    shutdown(): void {
        for (const queue of this.queues.values()) queue.shutdown();
    }

    private queueFor(endpointId: string): EndpointQueue {
        let queue = this.queues.get(endpointId);
        if (!queue) {
            queue = new EndpointQueue(endpointId, this.deps);
            this.queues.set(endpointId, queue);
        }
        return queue;
    }
}
