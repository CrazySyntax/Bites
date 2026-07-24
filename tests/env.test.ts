import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, resolveEnvPath } from "../src/env.js";

describe("resolveEnvPath", () => {
    it("reads the path from `--env-path <path>`", () => {
        expect(resolveEnvPath(["node", "script", "--env-path", "/tmp/custom.env"])).toBe(
            "/tmp/custom.env",
        );
    });

    it("reads the path from `--env-path=<path>`", () => {
        expect(resolveEnvPath(["node", "script", "--env-path=/tmp/custom.env"])).toBe(
            "/tmp/custom.env",
        );
    });

    it("returns undefined when the flag is absent", () => {
        expect(resolveEnvPath(["node", "script", "--other", "x"])).toBeUndefined();
    });
});

describe("loadEnv", () => {
    let dir: string;
    let file: string;
    // Keys used only by these tests; cleaned up so they don't leak between cases.
    const KEYS = ["ENV_TEST_A", "ENV_TEST_QUOTED", "ENV_TEST_PRESET"];

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "bites-env-"));
        file = join(dir, ".env");
        for (const k of KEYS) delete process.env[k];
    });

    afterEach(async () => {
        for (const k of KEYS) delete process.env[k];
        await rm(dir, { recursive: true, force: true });
    });

    it("loads KEY=VALUE pairs from a file, stripping surrounding quotes", async () => {
        await writeFile(file, ["ENV_TEST_A=hello", 'ENV_TEST_QUOTED="a b c"'].join("\n"));

        loadEnv(file);

        expect(process.env.ENV_TEST_A).toBe("hello");
        expect(process.env.ENV_TEST_QUOTED).toBe("a b c");
    });

    it("does not overwrite a variable already set in the real environment", async () => {
        process.env.ENV_TEST_PRESET = "fromreal";
        await writeFile(file, "ENV_TEST_PRESET=fromfile");

        loadEnv(file);

        expect(process.env.ENV_TEST_PRESET).toBe("fromreal");
    });

    it("is a no-op when the file is missing and not required", () => {
        expect(() => loadEnv(join(dir, "absent.env"))).not.toThrow();
    });

    it("throws when a required file is missing (explicit --env-path)", () => {
        expect(() => loadEnv(join(dir, "absent.env"), { required: true })).toThrow(
            /env file not found/,
        );
    });
});
