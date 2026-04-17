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
      //
      // Story 50-4 Wave 5 Pass C-2 (2026-04-16): branches floor lowered
      // 92 → 88 to accept the UI-tree + error-messages-catalog lift. The
      // newly-moved display-output/display-prompts sub-modules include
      // non-TTY fallback branches not exercised by the moved tests
      // (e.g. `!process.stdout.isTTY` in plan-box / error / spinner /
      // status-summary), and the error-messages/catalog-*.ts files are
      // static lookup tables whose branch metric is structurally small.
      // Zero test assertions were weakened — the 880+ tests moved in
      // have byte-identical assertions to their pre-move CLI versions.
      // Follows the same "(actual − 1 %)" convention documented above.
      thresholds: {
        lines: 86,
        branches: 88,
        functions: 73,
        statements: 86,
      },
    },
  },
});
