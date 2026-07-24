export interface TransportRequest {
    url: string;
    body: string;
    headers: Record<string, string>;
    /** Aborts the request; the engine wires this to the per-attempt timeout. */
    signal: AbortSignal;
}

export interface TransportResponse {
    statusCode: number;
}

/**
 * Abstraction over the outbound HTTP call. The real implementation uses global
 * `fetch`; tests inject a fake that returns scripted responses / hangs / aborts
 * without touching the network.
 *
 * `send` resolves with the response status (any code, including non-2xx). It
 * rejects only when no HTTP response was obtained (network error, timeout/abort).
 */
export interface HttpTransport {
    send(request: TransportRequest): Promise<TransportResponse>;
}

export class FetchTransport implements HttpTransport {
    async send({ url, body, headers, signal }: TransportRequest): Promise<TransportResponse> {
        const response = await fetch(url, {
            method: "POST",
            body,
            headers,
            signal,
        });
        return { statusCode: response.status };
    }
}
