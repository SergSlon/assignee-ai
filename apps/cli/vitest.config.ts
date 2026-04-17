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
      // Story 50-4 Wave 5 Pass C — restrict coverage scope to the published
      // library surface. `scripts/` is developer tooling (fixture capture,
      // shell completion generation), executed manually via `pnpm tsx`;
      // it never ships with the compiled CLI and never has unit tests, so
      // leaving it in the denominator dragged coverage down artificially.
      include: ["src/**/*.ts"],
      // Story 50-6 — coverage floors baselined at (actual − 1 %) so the
      // coordinator's CI-parity `pnpm -r test:coverage` run fails fast
      // on a regression. Raise these numbers as coverage grows; never
      // lower them to paper over a regression.
      //
      // Story 50-4 Wave 5 Pass C: after moving ~230 well-covered utility
      // tests to @assignee/core, the CLI branch coverage settled at 82.76%.
      // Branches floor lowered to 82 (new actual − 1%), matching the same
      // convention used when 50-6 set the original floors. The lines/
      // statements/functions floors continue to hold at their Pass A+B
      // values because the `src/**/*.ts` include above excludes the
      // scripts/ directory from the denominator.
      thresholds: {
        lines: 83,
        branches: 82,
        functions: 87,
        statements: 83,
      },
    },
  },
});
