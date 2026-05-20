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
    // Epic 99 Lane 3b: retry once on failure before reporting red.
    // Covers timing jitter on shared CI runners without masking real bugs —
    // a test that needs 2+ retries is unreliable by definition and must be
    // quarantined or fixed. Never weaken assertions instead (feedback_never_weaken_tests).
    // See docs/explanation/flake-policy.md for the full SLO and quarantine process.
    retry: 1,
    // Explicitly pin `forks` pool on Windows to attempt fixing the
    // vitest RPC `onTaskUpdate` heartbeat timeout at teardown (see runs
    // 26155431035, 26156180682, 26183888000, 26188347821). POSIX cells
    // keep vitest's default pool (also `forks` in 3.x; `threads` breaks
    // tests that call `process.chdir()` because worker_threads disallow
    // it). The spread-pattern only inserts the key on Windows so POSIX
    // behaviour is unchanged.
    ...(process.platform === "win32" && { pool: "forks" as const }),
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      reportsDirectory: "./coverage",
      // Story 50-6 — coverage floors baselined at (actual − 1 %) so the
      // coordinator's CI-parity `pnpm -r test:coverage` run fails fast
      // on a regression. Raise these numbers as coverage grows; never
      // lower them to paper over a regression.
      thresholds: {
        lines: 88,
        branches: 83,
        functions: 93,
        statements: 88,
      },
    },
  },
});
