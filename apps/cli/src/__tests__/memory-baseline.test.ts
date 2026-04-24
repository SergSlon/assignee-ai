/**
 * NFR memory floor — in-process heap stability gate (T-004).
 *
 * Run with: RUN_PERF=1 pnpm --filter assignee exec vitest run src/__tests__/memory-baseline.test.ts
 *
 * Default CI skips these — they are intended for a dedicated perf workflow or
 * manual release-candidate qualification.
 *
 * Design rationale:
 *   A full e2e plan loop is intentionally NOT used here. Goal is a unit-level
 *   leak detector for in-process state accumulation — specifically:
 *     • INTENT_RULES iteration and Set/Map allocations in getIntentDefaults()
 *     • Spread-clone allocations in applyIntentOverrides()
 *     • plugin-defaults registry lookups (Map-backed)
 *   These are the modules identified in T-004 as most likely to accumulate
 *   uncollected state across repeated wizard invocations.
 *
 *   Full e2e plan with mocked MCP is left for Epic 100+ once the MCP mock
 *   harness is more ergonomic (currently requires complex DI wiring in
 *   packages/core/src/graph/).
 *
 * Threshold rationale:
 *   20% heap growth over 10 synthetic invocations post-warmup. If there is no
 *   leak the heap should be essentially flat (GC rounds to same working set).
 *   20% allows normal JIT/GC jitter without triggering a false positive.
 *   A real leak (accumulating Map entries, non-freed closures) typically shows
 *   50-200%+ growth over 10 iterations.
 *
 * Epic 100+ TODO:
 *   1. Extend syntheticPlan() to invoke the full option-elicitor node with
 *      a fully mocked MCP transport once the harness exposes a clean DI seam.
 *   2. Add a soak variant: 100 iterations, assert p99 heap < 2× baseline.
 *   3. Wire into the dedicated `perf` GitHub Actions workflow alongside the
 *      startup-percentile gate so both run on every main-branch push.
 */

import { describe, it, expect } from "vitest";
import {
  getIntentDefaults,
  applyIntentOverrides,
  INTENT_RULES,
} from "@assignee/core";
import type { IntentRule } from "@assignee/core";

describe("memory baseline (RUN_PERF=1 only)", () => {
  /**
   * Gate: tests only execute when RUN_PERF=1 is set.
   * Without it they appear as "skipped" in the vitest output so default
   * `pnpm test` / `pnpm -r test:coverage` stays fast.
   */
  const gate = process.env["RUN_PERF"] === "1" ? describe : describe.skip;

  gate("synthetic intent-defaults loop heap stability", () => {
    it("heapUsed stays within ±20% of baseline across 10 synthetic invocations", async () => {
      // Warmup: 3 runs to stabilize JIT + module caches before we take the
      // baseline reading. Without warmup the baseline itself may be mid-JIT
      // and the comparison heap is post-JIT, giving a misleading drop.
      for (let i = 0; i < 3; i++) {
        await syntheticPlan();
        if (typeof globalThis.gc === "function") globalThis.gc();
      }

      if (typeof globalThis.gc === "function") globalThis.gc();
      const baseline = process.memoryUsage().heapUsed;

      for (let i = 0; i < 10; i++) {
        await syntheticPlan();
      }

      if (typeof globalThis.gc === "function") globalThis.gc();
      const final = process.memoryUsage().heapUsed;

      const growthPct = ((final - baseline) / baseline) * 100;

      // Telemetry log — visible in CI output even on pass.
      console.log(
        `memory-baseline: ` +
          `baseline=${(baseline / 1024 / 1024).toFixed(1)}MB ` +
          `final=${(final / 1024 / 1024).toFixed(1)}MB ` +
          `growth=${growthPct.toFixed(1)}%`,
      );

      // ±20% allows normal GC jitter; a real leak shows 50-200%+ growth.
      expect(Math.abs(growthPct)).toBeLessThan(20);
    }, 30_000); // Allow up to 30s — GC pressure can make this test slow on constrained runners.
  });
});

/**
 * Fake ResourceField array (minimal structure matching the ResourceField
 * interface) — built from INTENT_RULES so the applyIntentOverrides path
 * has real field names to match against, exercising the spread-clone and
 * Map construction paths without importing the full resource-plugin layer.
 */
function makeFakeFields(rules: IntentRule[]) {
  return rules.slice(0, 5).flatMap((r) =>
    r.overrides.slice(0, 3).map((o) => ({
      name: o.fieldName,
      question: {
        type: "text" as const,
        label: o.fieldName,
        message: "test",
        hint: undefined as string | undefined,
        initialValue: undefined as unknown,
        options: undefined as { value: string; label: string }[] | undefined,
      },
    })),
  );
}

/**
 * One synthetic "plan" iteration — exercises in-process allocations made by
 * the intent-defaults pipeline without spawning child processes.
 *
 * Covers: INTENT_RULES iteration, Set/Map churn inside getIntentDefaults,
 * spread-clone Map construction in applyIntentOverrides.
 */
async function syntheticPlan(): Promise<void> {
  // Sample intents that exercise different rule branches across all resource types.
  const intents: { intent: string; resourceType: string }[] = [
    {
      intent: "I need an api handler for REST",
      resourceType: "AWS::Lambda::Function",
    },
    {
      intent: "background worker for batch processing",
      resourceType: "AWS::Lambda::Function",
    },
    {
      intent: "create a web server instance",
      resourceType: "AWS::EC2::Instance",
    },
    { intent: "cheap dev environment", resourceType: "AWS::EC2::Instance" },
    {
      intent: "public s3 bucket for static site",
      resourceType: "AWS::S3::Bucket",
    },
    { intent: "private secure storage", resourceType: "AWS::S3::Bucket" },
    {
      intent: "production rds postgres",
      resourceType: "AWS::RDS::DBInstance",
    },
    {
      intent: "dev database no backups",
      resourceType: "AWS::RDS::DBInstance",
    },
  ];

  const fakeFields = makeFakeFields(INTENT_RULES);

  for (const { intent, resourceType } of intents) {
    const overrides = getIntentDefaults(intent, resourceType);
    // applyIntentOverrides returns a new array — ensures we exercise the
    // spread-clone path that could leak if it accumulates closures.
    applyIntentOverrides(
      // Cast via `unknown` — the fake fixture has minimal FieldQuestion
      // shape (just enough for the applyIntentOverrides path to walk);
      // the full ResourceField["question"] type carries QuestionType
      // discriminators that aren't needed for this memory-soak test.
      fakeFields as unknown as Parameters<typeof applyIntentOverrides>[0],
      overrides,
    );
  }

  // Yield to the event loop once per iteration so any microtask-queued
  // allocations are flushed before we take the final heap reading.
  await Promise.resolve();
}
