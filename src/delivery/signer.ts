import { createHmac } from "node:crypto";

/**
 * Computes the value for the `X-Signature` header: an HMAC-SHA256 of the exact
 * request body bytes, keyed by the endpoint's secret.
 *
 * Format is `sha256=<hex>` (GitHub-style) so the algorithm is self-describing
 * and customers know how to reproduce it.
 */
export function sign(rawBody: string, secret: string): string {
    const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    return `sha256=${digest}`;
}
