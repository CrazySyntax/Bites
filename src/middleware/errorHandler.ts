import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors.js";

/**
 * Centralized error mapping. Typed {@link AppError}s become their carried
 * status; anything unexpected becomes a 500. Placed last in the middleware
 * chain (Express 5 forwards rejected async handlers here automatically).
 */
export function errorHandler(
    err: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
): void {
    if (err instanceof AppError) {
        res.status(err.status).json({ error: err.message });
        return;
    }

    // Malformed JSON bodies surface as SyntaxError from express.json().
    if (err instanceof SyntaxError && "body" in err) {
        res.status(400).json({ error: "invalid JSON body" });
        return;
    }

    console.error("Unhandled error:", err);
    res.status(500).json({ error: "internal server error" });
}
