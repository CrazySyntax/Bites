export interface CancellableSleep {
    /** Resolves when the delay elapses, or immediately if cancelled. */
    promise: Promise<void>;
    /** Clears the underlying timer and resolves the promise early. */
    cancel: () => void;
}

/**
 * A `setTimeout`-based delay that can be cancelled. Used for backoff waits so
 * they can be interrupted on pause/shutdown and so tests (with Jest fake
 * timers) don't leak open handles.
 */
export function cancellableSleep(ms: number): CancellableSleep {
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
