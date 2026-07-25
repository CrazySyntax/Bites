import { createHmac } from "node:crypto";
import type { Attempt, WebhookEvent } from "../types.js";
import type { DeliveryDeps } from "./deliveryDeps.js";
import {DeliveryConfig} from "../config.js";

interface CancellableSleep {
    /** Resolves when the delay elapses, or immediately if cancelled. */
    promise: Promise<void>;
    /** Clears the underlying timer and resolves the promise early. */
    cancel: () => void;
}

/**
 * A single endpoint's delivery pipeline: an ordered FIFO of event ids drained
 * by one worker loop.
 *
 * Ordering guarantee: the head event is *peeked* (not removed) and retried in
 * place until it reaches a terminal state (`delivered` or `dead`). Only then is
 * it shifted off and the next event begins. This is deliberate head-of-line
 * blocking — the correct reading of "events for the same endpoint are delivered
 * in order". A later event can never overtake an earlier one that is still
 * retrying.
 *
 * Isolation guarantee: each endpoint has its own queue + loop. A slow or down
 * endpoint parks inside its own `await` (fetch or backoff), leaving the event
 * loop free to drive every other endpoint's queue concurrently.
 */
export class EndpointQueue {
    private readonly eventIds: string[] = [];
    private running = false;
    private paused = false;
    private backoff?: CancellableSleep;
    private activeAbort?: AbortController;
    private idleResolvers: Array<() => void> = [];

    constructor(
        private readonly endpointId: string,
        private readonly deps: DeliveryDeps,
    ) {}

    /** Append an event to the tail and start draining if idle. */
    enqueue(eventId: string): void {
        this.eventIds.push(eventId);
        this.wake();
    }

    /** Stop pulling new work; interrupt any in-progress backoff wait. */
    pause(): void {
        this.paused = true;
        this.backoff?.cancel();
    }

    /** Allow pulling work again and kick the loop. */
    resume(): void {
        this.paused = false;
        this.wake();
    }

    /** Pause and abort the in-flight request (used on process shutdown). */
    shutdown(): void {
        this.pause();
        this.activeAbort?.abort();
    }

    /**
     * Idempotent entry point. Safe to call from enqueue/resume as often as you
     * like: concurrent calls collapse into the one live loop via the `running`
     * guard, so the queue is never double-drained.
     */
    wake(): void {
        if (this.running || this.paused || this.eventIds.length === 0) return;
        this.running = true;
        void this.run();
    }

    /** Resolves the next time this queue goes idle (test/shutdown affordance). */
    onIdle(): Promise<void> {
        if (!this.running) return Promise.resolve();
        return new Promise((resolve) => this.idleResolvers.push(resolve));
    }

    private async run(): Promise<void> {
        try {
            while (!this.paused && this.eventIds.length > 0) {
                const eventId = this.eventIds[0]; // peek — do not shift until terminal
                const event = await this.deps.events.findById(eventId);
                if (!event) {
                    this.eventIds.shift(); // defensive: event vanished
                    continue;
                }

                await this.attemptDelivery(event);

                if (event.status === "delivered" || event.status === "dead") {
                    this.eventIds.shift();
                    continue;
                }

                // Failed but retryable: wait out the backoff, keeping the event at the
                // head so nothing overtakes it, then loop to retry the same event.
                const delayMs = this.computeBackoffMs(event.attemptCount, this.deps.config, this.deps.rng);
                this.backoff = this.cancellableSleep(delayMs);
                await this.backoff.promise;
                this.backoff = undefined;
            }
        } finally {
            this.running = false;
            this.flushIdle();
        }
    }

    /** Performs exactly one delivery attempt and records it on the event. */
    private async attemptDelivery(event: WebhookEvent): Promise<void> {
        // The event stays `pending` while an attempt is in flight — there is no
        // separate "delivering" state. It only leaves `pending` on a terminal
        // outcome: `delivered` (2xx) or `dead` (attempts exhausted).
        const attemptNumber = event.attempts.length + 1;
        const controller = new AbortController();
        this.activeAbort = controller;
        const timeout = setTimeout(() => controller.abort(), this.deps.config.timeoutMs);
        const start = this.deps.now();

        let attempt: Attempt;
        try {
            const endpoint = await this.deps.endpoints.findById(event.endpointId);
            if (!endpoint) throw new Error("endpoint not found");

            const headers: Record<string, string> = {
                "content-type": "application/json",
                "x-signature": this.sign(event.rawPayload, endpoint.secret),
                "x-event-id": event.id,
                "x-event-timestamp": event.createdAt,
                "x-attempt": String(attemptNumber),
            };

            const response = await this.deps.transport.send({
                url: endpoint.url,
                body: event.rawPayload,
                headers,
                signal: controller.signal,
            });

            attempt = {
                attemptNumber,
                timestamp: new Date(start).toISOString(),
                statusCode: response.statusCode,
                durationMs: this.deps.now() - start,
            };

            if (response.statusCode >= 200 && response.statusCode < 300) {
                event.status = "delivered";
            } else {
                this.registerFailure(event);
            }
        } catch (err) {
            const error = controller.signal.aborted ? "timeout" : errorMessage(err);
            attempt = {
                attemptNumber,
                timestamp: new Date(start).toISOString(),
                error,
                durationMs: this.deps.now() - start,
            };
            this.registerFailure(event);
        } finally {
            clearTimeout(timeout);
            this.activeAbort = undefined;
        }

        event.attempts.push(attempt);
        await this.deps.events.save(event);
    }

    /**
     * Exponential backoff with full jitter.
     *
     * `attemptCount` is the number of failures so far (>= 1). The base delay grows
     * as base * factor^(attemptCount-1), capped at backoffMaxMs, plus a random
     * jitter in [0, base) to avoid synchronized retries ("thundering herd").
     *
     * `rng` is injectable so tests can pass `() => 0` for deterministic delays.
     */
    private computeBackoffMs(
        attemptCount: number,
        config: DeliveryConfig,
        rng: () => number = Math.random,
    ): number {
        const exponential = config.backoffBaseMs * config.backoffFactor ** (attemptCount - 1);
        const capped = Math.min(exponential, config.backoffMaxMs);
        const jitter = rng() * config.backoffBaseMs;
        return Math.round(capped + jitter);
    }

    /**
     * Computes the value for the `X-Signature` header: an HMAC-SHA256 of the exact
     * request body bytes, keyed by the endpoint's secret.
     *
     * Format is `sha256=<hex>` (GitHub-style) so the algorithm is self-describing
     * and customers know how to reproduce it.
     */
    private sign(rawBody: string, secret: string): string {
        const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
        return `sha256=${digest}`;
    }

    /**
     * A `setTimeout`-based delay that can be cancelled. Used for backoff waits so
     * they can be interrupted on pause/shutdown and so tests (with Jest fake
     * timers) don't leak open handles.
     */
    private cancellableSleep(ms: number): CancellableSleep {
        let timer: NodeJS.Timeout | undefined;
        let resolveFn: (() => void) | undefined;

        const promise = new Promise<void>((resolve) => {
            resolveFn = resolve;
            timer = setTimeout(() => {
                timer = undefined;
                resolve();
            }, ms);
        });

        const cancel = () => {
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
            resolveFn?.();
        };

        return { promise, cancel };
    }

    private registerFailure(event: WebhookEvent): void {
        event.attemptCount += 1;
        // Assumption: if a delivery fails while its endpoint is paused, give up on
        // that event immediately (mark it `dead`) rather than scheduling a retry —
        // even if it has attempts left. A paused endpoint is not expected to
        // recover on its own, so retrying against it is wasted work. See README
        // "Assumptions". Other queued events stay `pending` and resume normally.
        if (this.paused || event.attemptCount >= this.deps.config.maxAttempts) {
            event.status = "dead";
        } else {
            event.status = "pending";
        }
    }

    private flushIdle(): void {
        const resolvers = this.idleResolvers;
        this.idleResolvers = [];
        for (const resolve of resolvers) resolve();
    }
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
