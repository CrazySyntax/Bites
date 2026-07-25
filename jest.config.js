/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
    preset: "ts-jest/presets/default-esm",
    testEnvironment: "node",
    extensionsToTreatAsEsm: [".ts"],
    // NodeNext source uses `.js` specifiers on relative imports; strip them so
    // Jest resolves the corresponding `.ts` file.
    moduleNameMapper: {
        "^(\\.{1,2}/.*)\\.js$": "$1",
    },
    transform: {
        "^.+\\.ts$": ["ts-jest", { useESM: true }],
    },
    testMatch: ["**/*.test.ts"],
    clearMocks: true,
    // Runs before any source module loads, so LOG_LEVEL is `silent` by the time
    // config.ts is imported and the app's ConsoleLoggers stay quiet in the suite.
    setupFiles: ["<rootDir>/jest.setup.ts"],
};
