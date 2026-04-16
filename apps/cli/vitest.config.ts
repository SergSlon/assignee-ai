import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test-setup.ts"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Serialize tests within a file to eliminate coverage-v8 ENOENT race on
    // `coverage/.tmp/coverage-*.json` (vitest@3.1.x + @vitest/coverage-v8).
    // Story 48.8 — less runtime impact than switching to pool: "forks".
    maxConcurrency: 1,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      reportsDirectory: "./coverage",
    },
  },
});
