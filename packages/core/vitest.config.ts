import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      reportsDirectory: "./coverage",
      // Story 50-6 — coverage floors baselined at (actual − 1 %) so the
      // coordinator's CI-parity `pnpm -r test:coverage` run fails fast
      // on a regression. Raise these numbers as coverage grows; never
      // lower them to paper over a regression.
      thresholds: {
        lines: 86,
        branches: 92,
        functions: 73,
        statements: 86,
      },
    },
  },
});
