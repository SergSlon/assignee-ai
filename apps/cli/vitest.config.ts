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
      // Story 50-6 — coverage floors baselined at (actual − 1 %) so the
      // coordinator's CI-parity `pnpm -r test:coverage` run fails fast
      // on a regression. Raise these numbers as coverage grows; never
      // lower them to paper over a regression.
      thresholds: {
        lines: 83,
        branches: 83,
        functions: 87,
        statements: 83,
      },
    },
  },
});
