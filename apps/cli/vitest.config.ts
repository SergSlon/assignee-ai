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
      //
      // Story 50-4 Wave 5 Pass H.2 (2026-04-17): floors recalibrated after
      // relocating the 6 large node test files (option-elicitor,
      // plan-generator, preflight-guard, preflight-guard-pricing,
      // pricing-decomposer-all, resource-provisioner) + wizard-e2e +
      // tocfn-exhaustive + plan-generator.safeClone +
      // 6 wizard-matrix tests + test-fixtures/mcp-mock-responses from
      // apps/cli/src/ to packages/core/src/ — those tests exercised
      // core-lifted code (option-elicitor node body, plan-generator,
      // preflight-guard, pricing decomposers, etc.) that moved into
      // @assignee/core during Passes D–H of Story 50-4 Wave 5. Their
      // coverage contribution now credits core, not CLI. CLI floors
      // lowered by the actual-minus-1 rule:
      //   lines: 83 → 79 (actual 80.80 − ~1)
      //   statements: 83 → 79 (same numerator/denominator)
      //   branches: 82 → 77 (actual 78.03 − ~1)
      //   functions: 87 → 88 (functions coverage stayed at 88.85,
      //     kept at 87 — no regression)
      // Zero test assertions were weakened; only mock-target paths
      // and test-side import paths changed. Pass I's createGraph lift
      // will clean up remaining CLI/core split points.
      thresholds: {
        lines: 79,
        branches: 77,
        functions: 87,
        statements: 79,
      },
    },
  },
});
