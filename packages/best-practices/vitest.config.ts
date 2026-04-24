import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Epic 99 Lane 3b: retry once on failure before reporting red.
    // Covers timing jitter on shared CI runners without masking real bugs —
    // a test that needs 2+ retries is unreliable by definition and must be
    // quarantined or fixed. Never weaken assertions instead (feedback_never_weaken_tests).
    // See docs/explanation/flake-policy.md for the full SLO and quarantine process.
    retry: 1,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      reportsDirectory: "./coverage",
      // Exclude CLI scripts from coverage — these are contributor-facing
      // entry points (`pnpm --filter=@assignee/best-practices run
      // generate-manifest` / the Story 50-10 `validate.ts` helper) that
      // execute outside vitest. Their logic is exercised through the
      // underlying `src/` modules, which ARE covered. Including them
      // here would drop package coverage artificially because `v8`
      // instruments files even when no test imports them.
      exclude: [
        "scripts/**",
        "**/*.test.ts",
        "**/__tests__/**",
        "**/fixtures/**",
        "**/node_modules/**",
        "**/dist/**",
        "**/coverage/**",
      ],
      // Coverage floors baselined at (actual − 1 %) so the coordinator's
      // CI-parity `pnpm -r test:coverage` run fails fast on a regression.
      // Raise these numbers as coverage grows; never lower them to paper
      // over a NEW regression.
      //
      // Rebaseline 2026-04-17: Story 50-3 deleted the GPG-signing test
      // surface (integrity layer now SHA-256 only; see
      // `integrity.ts:2-4`). That drop was intentional — the deleted
      // tests exercised code that was also deleted — but it left the
      // remaining `integrity.ts` error-path lines partially uncovered,
      // pushing the package from ~89 % to ~82 %. Threshold lowered to
      // match the new post-deletion baseline minus 1 %.
      thresholds: {
        lines: 81,
        branches: 84,
        functions: 89,
        statements: 81,
      },
    },
  },
});
