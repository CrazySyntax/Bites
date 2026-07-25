import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { ConsoleLogger, redactEndpoint } from "../src/logger.js";
import type { Endpoint } from "../src/types.js";

/**
 * The application's loggers are not injected — each service/queue constructs its
 * own `ConsoleLogger`. So the observable seam is the console itself: these tests
 * spy on `console.log`/`console.error` and drive a `ConsoleLogger` with an
 * explicit level (which overrides the `LOG_LEVEL` env default the app uses).
 */
function spyConsole() {
    const info: string[] = [];
    const error: string[] = [];
    const logSpy = jest.spyOn(console, "log").mockImplementation((line?: unknown) => {
        info.push(String(line));
    });
    const errorSpy = jest.spyOn(console, "error").mockImplementation((line?: unknown) => {
        error.push(String(line));
    });
    return { info, error, restore: () => (logSpy.mockRestore(), errorSpy.mockRestore()) };
}

const ENDPOINT: Endpoint = {
    id: "ep_1",
    url: "http://hook.test/x",
    secret: "a".repeat(64),
    status: "active",
    createdAt: "2026-07-25T00:00:00.000Z",
};

describe("ConsoleLogger", () => {
    let spy: ReturnType<typeof spyConsole>;
    afterEach(() => spy?.restore());

    it("writes INFO lines to stdout with the message and inspected data", () => {
        spy = spyConsole();
        const logger = new ConsoleLogger("info");

        logger.info("event.changed", { id: "evt_1", status: "delivered" });

        expect(spy.info).toHaveLength(1);
        expect(spy.error).toHaveLength(0);
        expect(spy.info[0]).toContain("INFO");
        expect(spy.info[0]).toContain("event.changed");
        expect(spy.info[0]).toContain("id: 'evt_1'");
        expect(spy.info[0]).toContain("status: 'delivered'");
    });

    it("writes ERROR lines to stderr", () => {
        spy = spyConsole();
        const logger = new ConsoleLogger("info");

        logger.error("delivery.failed", { statusCode: 500, attempt: 1 });

        expect(spy.error).toHaveLength(1);
        expect(spy.info).toHaveLength(0);
        expect(spy.error[0]).toContain("ERROR");
        expect(spy.error[0]).toContain("delivery.failed");
        expect(spy.error[0]).toContain("statusCode: 500");
    });

    it("omits the data segment when no data is passed", () => {
        spy = spyConsole();
        const logger = new ConsoleLogger("info");

        logger.info("endpoint.created");

        expect(spy.info[0].endsWith("endpoint.created")).toBe(true);
    });

    it("suppresses INFO but still logs ERROR at the 'error' level", () => {
        spy = spyConsole();
        const logger = new ConsoleLogger("error");

        logger.info("event.changed", { id: "evt_1" });
        logger.error("delivery.failed", { statusCode: 500 });

        expect(spy.info).toHaveLength(0); // info gated off
        expect(spy.error).toHaveLength(1);
    });

    it("suppresses everything at the 'silent' level", () => {
        spy = spyConsole();
        const logger = new ConsoleLogger("silent");

        logger.info("event.changed", { id: "evt_1" });
        logger.error("delivery.failed", { statusCode: 500 });

        expect(spy.info).toHaveLength(0);
        expect(spy.error).toHaveLength(0);
    });

    it("never prints the real secret when logging a redacted endpoint", () => {
        spy = spyConsole();
        const logger = new ConsoleLogger("info");

        logger.info("endpoint.created", redactEndpoint(ENDPOINT));

        expect(spy.info[0]).toContain("secret: '[redacted]'");
        expect(spy.info[0]).not.toContain(ENDPOINT.secret);
    });
});

describe("redactEndpoint", () => {
    it("replaces the secret with a placeholder", () => {
        const redacted = redactEndpoint(ENDPOINT);
        expect(redacted.secret).toBe("[redacted]");
    });

    it("returns a copy and does not mutate the original", () => {
        const redacted = redactEndpoint(ENDPOINT);
        expect(ENDPOINT.secret).toBe("a".repeat(64)); // original untouched
        expect(redacted).not.toBe(ENDPOINT);
        expect(redacted.id).toBe(ENDPOINT.id);
        expect(redacted.url).toBe(ENDPOINT.url);
        expect(redacted.status).toBe(ENDPOINT.status);
    });
});
