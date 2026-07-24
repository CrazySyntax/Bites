import { createHmac } from "node:crypto";
import { sign } from "../src/delivery/signer.js";

describe("sign", () => {
    it("produces an sha256-prefixed hex HMAC of the body", () => {
        const secret = "super-secret";
        const body = JSON.stringify({ hello: "world" });

        const expectedHex = createHmac("sha256", secret).update(body, "utf8").digest("hex");

        expect(sign(body, secret)).toBe(`sha256=${expectedHex}`);
    });

    it("is deterministic for the same body + secret", () => {
        expect(sign("payload", "k")).toBe(sign("payload", "k"));
    });

    it("changes when the secret changes", () => {
        expect(sign("payload", "k1")).not.toBe(sign("payload", "k2"));
    });

    it("changes when a single byte of the body changes", () => {
        expect(sign('{"a":1}', "k")).not.toBe(sign('{"a":2}', "k"));
    });
});
