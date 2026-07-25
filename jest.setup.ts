// Silence the application's ConsoleLoggers during tests. Each service/queue now
// constructs its own logger (no injection), reading LOG_LEVEL at construction.
// Setting it here — before any source module is imported — makes the whole suite
// quiet without a per-class seam. Unit tests that need to observe output build a
// `new ConsoleLogger(level)` with an explicit level, which overrides this default.
process.env.LOG_LEVEL = "silent";

export {};
