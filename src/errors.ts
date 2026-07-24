/**
 * An error that carries the HTTP status it should map to. The centralized
 * error-handling middleware translates these into responses; anything else
 * becomes a 500.
 */
export class AppError extends Error {
    constructor(
        public readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = "AppError";
    }
}

export const badRequest = (message: string) => new AppError(400, message);
export const notFound = (message: string) => new AppError(404, message);
export const conflict = (message: string) => new AppError(409, message);
/** A capacity limit was hit; surfaced as HTTP 500 per the documented assumption. */
export const capacityExceeded = (message: string) => new AppError(500, message);
