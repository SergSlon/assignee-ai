/**
 * NFR latency floor — CLI cold-start percentile gate (T-003).
 *
 * Run with: RUN_PERF=1 pnpm --filter assignee exec vitest run src/__tests__/startup-percentile.test.ts
 *
 * Default CI skips these — they are intended for a dedicated perf workflow or
 * manual release-candidate qualification. Each run spawns 50 fresh node
 * processes (~800ms each), taking ~40-50 seconds total.
 *
 * Threshold rationale (measured 2026-04-24, Node 22, Apple Silicon M-series):
 *   20-sample local baseline: p50=838ms, p95=854ms, p99=868ms, max=868ms
 *   Thresholds = max × 1.5 → p95 < 1300ms, p99 < 1400ms
 *   The extra headroom accommodates CI runner variance (GitHub Actions ~2×
 *   slower than local). If CI runners regularly observe p95 > 1000ms, bump
 *   thresholds in 200ms increments and record the CI runner type here.
 *
 * Epic 100+ TODO: wire this into a dedicated `perf` GitHub Actions workflow
 * triggered on main-branch pushes (separate from the standard CI matrix) so
 * percentile creep is caught automatically without burning test time in every PR.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";

const DIST_ENTRY = resolve(
  new URL(".", import.meta.url).pathname,
  // From apps/cli/src/__tests__/ → ../../ → apps/cli/ → dist/index.js
  "../../dist/index.js",
);

describe("CLI startup percentiles (RUN_PERF=1 only)", () => {
  /**
   * Gate: tests only execute when RUN_PERF=1 is set.
   * Without it they appear as "skipped" in the vitest output so default
   * `pnpm test` / `pnpm -r test:coverage` stays fast.
   */
  const gate = process.env["RUN_PERF"] === "1" ? describe : describe.skip;

  gate("--version cold start", () => {
    // 50 invocations × ~900ms each = ~45s. Vitest default is 30s, so we
    // set an explicit 120_000ms timeout to cover slow CI runners.
    it("p95 < 1300ms, p99 < 1400ms over 50 invocations", () => {
      const n = 50;
      const times: number[] = [];

      for (let i = 0; i < n; i++) {
        const start = performance.now();
        execFileSync("node", [DIST_ENTRY, "--version"], {
          stdio: "pipe",
        });
        times.push(performance.now() - start);
      }

      const sorted = times.slice().sort((a, b) => a - b);
      // Percentile: ceiling index so e.g. n=50, 95th percentile →
      // ceil(50×0.95)−1 = ceil(47.5)−1 = 48−1 = index 47 (0-based).
      const p50idx = Math.floor(n / 2);
      const p95idx = Math.ceil(n * 0.95) - 1;
      const p99idx = Math.ceil(n * 0.99) - 1;

      const p50 = sorted[p50idx]!;
      const p95 = sorted[p95idx]!;
      const p99 = sorted[p99idx]!;

      // Telemetry log — visible in CI output even on pass so we can track drift.
      console.log(
        `startup-percentile: n=${n} ` +
          `p50=${p50.toFixed(0)}ms ` +
          `p95=${p95.toFixed(0)}ms ` +
          `p99=${p99.toFixed(0)}ms ` +
          `max=${sorted[n - 1]!.toFixed(0)}ms`,
      );

      // Thresholds: local max (868ms) × 1.5, rounded to nearest 100ms.
      // Raise in 200ms steps if CI runners consistently exceed; document the
      // runner type and new observed baseline in the comment block above.
      expect(p95).toBeLessThan(1300);
      expect(p99).toBeLessThan(1400);
    }, 120_000); // ms — 50 spawns × ~900ms each ≈ 45s; 120s covers slow CI runners
  });
});
