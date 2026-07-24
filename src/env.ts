import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Extracts an optional `.env` file path from command-line arguments, supporting
 * both `--env-path <path>` and `--env-path=<path>`. Returns `undefined` when the
 * flag is absent, so callers fall back to the default `.env` lookup.
 *
 * Note the flag is deliberately NOT `--env-file`: Node itself consumes that flag
 * (built-in `.env` support) before the script's `process.argv` sees it, so a
 * distinct name is required to reach this code.
 */
export function resolveEnvPath(argv = process.argv): string | undefined {
    // Skip argv[0] (node) and argv[1] (script path).
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--env-path") return argv[i + 1]; // path is the next token
        if (arg.startsWith("--env-path=")) return arg.slice("--env-path=".length);
    }
    return undefined;
}

/**
 * Loads `KEY=VALUE` pairs from a `.env` file into `process.env` so `config.ts`
 * can read them. A missing file is a no-op — callers then fall back to the
 * defaults baked into `config.ts`.
 *
 * Real environment variables take precedence: an existing `process.env[key]` is
 * never overwritten, so `PORT=4000 npm start` still wins over a `.env` entry.
 *
 * Hand-rolled (no `dotenv` dependency) to match the project's zero-dependency,
 * hand-rolled-parsing style. Supports `#` comments, blank lines, an optional
 * `export ` prefix, and a single layer of surrounding single/double quotes.
 * Because it never overrides existing keys, calling it more than once is safe.
 *
 * A missing file is tolerated (defaults apply) unless `required` is set — used
 * when the caller passed an explicit path (e.g. `--env-file`) and a missing file
 * is a user error worth surfacing rather than silently ignoring.
 */
export function loadEnv(
    path = resolve(process.cwd(), ".env"),
    { required = false }: { required?: boolean } = {},
): void {
    let contents: string;
    try {
        contents = readFileSync(path, "utf8");
    } catch {
        if (required) throw new Error(`env file not found: ${path}`);
        return; // no .env file — defaults apply
    }

    for (const rawLine of contents.split("\n")) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#")) continue;

        const withoutExport = line.startsWith("export ") ? line.slice(7) : line;
        const eq = withoutExport.indexOf("=");
        if (eq === -1) continue;

        const key = withoutExport.slice(0, eq).trim();
        if (key === "") continue;

        let value = withoutExport.slice(eq + 1).trim();
        // Strip one layer of matching surrounding quotes, if present.
        const first = value[0];
        if (value.length >= 2 && (first === '"' || first === "'") && value.at(-1) === first) {
            value = value.slice(1, -1);
        }

        // Do not clobber a variable already set in the real environment.
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}
