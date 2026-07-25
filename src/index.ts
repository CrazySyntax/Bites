import { buildApp } from "./app.js";
import { createComposition } from "./composition.js";
import { PORT } from "./config.js";

const composition = createComposition();
const app = buildApp(composition);

// Every process invocation starts from a fresh, empty snapshot file. Live state
// is written to it by POST /database/dump.
await composition.databaseService.initEmptyFile();

const server = app.listen(PORT, () => {
    console.log(`Webhook delivery service running on http://localhost:${PORT}`);
});

/**
 * Graceful shutdown: stop accepting connections, then pause every queue and
 * abort in-flight deliveries so no timers leak. Note: storage is in-memory, so
 * queued/in-flight events are lost on restart (documented in the README).
 */
function shutdown(signal: string): void {
    console.log(`\n${signal} received, shutting down...`);
    composition.deliveryManager.shutdown();
    server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export default app;
