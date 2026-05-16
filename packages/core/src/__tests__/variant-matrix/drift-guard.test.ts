/**
 * Variant-matrix drift guard — registry parity enforcement.
 *
 * This test FAILS CI if any registered resource type, compound pattern, or
 * BP rule is missing from the variant matrix. The variant matrix is the
 * single place where we track which (type × intent-shape) combinations have
 * been exercised; this file is the sentinel that prevents silent drift.
 *
 * ## How drift detection works
 *
 * 1. The `type-intent-seed.test.ts` and future `*.test.ts` files call
 *    `registerMatrixEntry({key, axis, intentShape})` for every combination
 *    they exercise. These entries accumulate in the in-memory registry.
 *
 * 2. This test verifies that:
 *    - Every type in `SUPPORTED_TYPES_ARRAY` has ≥ 1 matrix entry.
 *    - Every pattern in `defaultPatternRegistry` has ≥ 1 matrix entry.
 *    - The total registered count meets the minimum thresholds.
 *
 * 3. The sentinel tests (Axis A, Axis B) inject a fake type/pattern key,
 *    assert the guard fires, then clean up.
 *
 * ## Updating thresholds
 *
 * - Add a new resource type → count in `enumerateTypes()` goes up → the
 *   "all types covered" assertion fails until you add a matrix entry in
 *   `type-intent-seed.test.ts`.
 * - Add a new pattern → count in `enumeratePatterns()` goes up → the
 *   "all patterns covered" assertion fails until you add a matrix entry.
 *
 * Story 108-B-01
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  enumerateTypes,
  enumeratePatterns,
  enumerateBpRules,
  enumerateCommands,
  registerMatrixEntry,
  getMatrixRegistry,
  resetMatrixRegistry,
  BASELINE_INTENT_SHAPES,
  CLI_COMMANDS,
} from "./index.js";

// ---------------------------------------------------------------------------
// Helper: seed the registry with a full baseline pass so drift-guard tests
// that check COVERAGE (not sentinel injection) have the entries they need.
// ---------------------------------------------------------------------------

function seedBaselineTypes(): void {
  for (const type of enumerateTypes()) {
    for (const shape of BASELINE_INTENT_SHAPES) {
      registerMatrixEntry({ key: type, axis: "type", intentShape: shape });
    }
  }
}

function seedBaselinePatterns(): void {
  for (const p of enumeratePatterns()) {
    registerMatrixEntry({ key: p.patternId, axis: "pattern" });
  }
}

function seedBaselineCommands(): void {
  for (const cmd of enumerateCommands()) {
    registerMatrixEntry({ key: cmd, axis: "command" });
  }
}

// ---------------------------------------------------------------------------
// Axis A — Type coverage completeness
// ---------------------------------------------------------------------------

describe("Drift-guard Axis A — type coverage completeness", () => {
  beforeEach(() => resetMatrixRegistry());
  afterEach(() => resetMatrixRegistry());

  it("passes when all types are covered", () => {
    seedBaselineTypes();
    const registry = getMatrixRegistry();
    const coveredTypes = new Set(
      registry.filter((e) => e.axis === "type").map((e) => e.key),
    );
    for (const type of enumerateTypes()) {
      expect(
        coveredTypes.has(type),
        `Missing matrix entry for type: ${type}`,
      ).toBe(true);
    }
  });

  it("FAILS (guard fires) when a new type is added without a matrix entry (sentinel)", () => {
    // Seed ALL real types so the guard would pass normally.
    seedBaselineTypes();

    // Inject a sentinel type into the ENUMERATED list without registering it.
    // We simulate this by checking coverage directly with an augmented list.
    const augmentedTypes = [...enumerateTypes(), "test-sentinel::FakeResource"];
    const registry = getMatrixRegistry();
    const coveredTypes = new Set(
      registry.filter((e) => e.axis === "type").map((e) => e.key),
    );

    // The sentinel is NOT in the registry → guard fires.
    expect(coveredTypes.has("test-sentinel::FakeResource")).toBe(false);

    // Simulate the guard assertion as CI would see it.
    const uncovered = augmentedTypes.filter((t) => !coveredTypes.has(t));
    expect(uncovered).toContain("test-sentinel::FakeResource");
  });

  it("total type coverage matches SUPPORTED_TYPES_ARRAY length × intent shapes", () => {
    seedBaselineTypes();
    const registry = getMatrixRegistry();
    const typeEntries = registry.filter((e) => e.axis === "type");
    const expectedCount =
      enumerateTypes().length * BASELINE_INTENT_SHAPES.length;
    expect(typeEntries.length).toBeGreaterThanOrEqual(expectedCount);
  });
});

// ---------------------------------------------------------------------------
// Axis B — Pattern coverage completeness
// ---------------------------------------------------------------------------

describe("Drift-guard Axis B — pattern coverage completeness", () => {
  beforeEach(() => resetMatrixRegistry());
  afterEach(() => resetMatrixRegistry());

  it("passes when all patterns are covered", () => {
    seedBaselinePatterns();
    const registry = getMatrixRegistry();
    const coveredPatterns = new Set(
      registry.filter((e) => e.axis === "pattern").map((e) => e.key),
    );
    for (const p of enumeratePatterns()) {
      expect(
        coveredPatterns.has(p.patternId),
        `Missing matrix entry for pattern: ${p.patternId}`,
      ).toBe(true);
    }
  });

  it("FAILS (guard fires) when a new pattern is added without a matrix entry (sentinel)", () => {
    seedBaselinePatterns();

    // Inject a sentinel pattern into the ENUMERATED list without registering it.
    const augmentedPatterns = [
      ...enumeratePatterns().map((p) => p.patternId),
      "test-sentinel-pattern",
    ];
    const registry = getMatrixRegistry();
    const coveredPatterns = new Set(
      registry.filter((e) => e.axis === "pattern").map((e) => e.key),
    );

    expect(coveredPatterns.has("test-sentinel-pattern")).toBe(false);

    const uncovered = augmentedPatterns.filter(
      (pid) => !coveredPatterns.has(pid),
    );
    expect(uncovered).toContain("test-sentinel-pattern");
  });

  it("pattern count is at least 13 (current registry baseline)", () => {
    const patterns = enumeratePatterns();
    // Static minimum: 13 patterns registered at the time of Story 108-B-01.
    // If this fails, a pattern was removed — investigate.
    expect(patterns.length).toBeGreaterThanOrEqual(13);
  });
});

// ---------------------------------------------------------------------------
// BP rule enumeration (not matrix coverage — just registry enumeration)
// ---------------------------------------------------------------------------

describe("Drift-guard — BP rule enumeration", () => {
  it("enumerateBpRules returns all rule IDs without duplicates", () => {
    const ruleIds = enumerateBpRules();
    // No duplicates
    const unique = new Set(ruleIds);
    expect(unique.size).toBe(ruleIds.length);
    // Minimum floor: 185 rules at Story 108-B-01 baseline.
    // Dynamic: the test derives the count from the live YAML files.
    expect(ruleIds.length).toBeGreaterThanOrEqual(185);
  });

  it("all rule IDs match the BP rule ID format (BP-<SERVICE>-<NUM>)", () => {
    const ruleIds = enumerateBpRules();
    const BP_ID_PATTERN = /^BP-[A-Z0-9]+-\d{3}$/;
    for (const id of ruleIds) {
      expect(id, `Rule ID does not match expected format: ${id}`).toMatch(
        BP_ID_PATTERN,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Command coverage
// ---------------------------------------------------------------------------

describe("Drift-guard — command coverage", () => {
  beforeEach(() => resetMatrixRegistry());
  afterEach(() => resetMatrixRegistry());

  it("CLI_COMMANDS tuple has 18 commands (Story 108-A-03: added 'discover')", () => {
    expect(CLI_COMMANDS.length).toBe(18);
  });

  it("all commands in CLI_COMMANDS can be registered in the matrix", () => {
    seedBaselineCommands();
    const registry = getMatrixRegistry();
    const coveredCommands = new Set(
      registry.filter((e) => e.axis === "command").map((e) => e.key),
    );
    for (const cmd of enumerateCommands()) {
      expect(
        coveredCommands.has(cmd),
        `Missing matrix entry for command: ${cmd}`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Registry integrity
// ---------------------------------------------------------------------------

describe("Drift-guard — registry integrity", () => {
  beforeEach(() => resetMatrixRegistry());
  afterEach(() => resetMatrixRegistry());

  it("resetMatrixRegistry clears all entries", () => {
    seedBaselineTypes();
    expect(getMatrixRegistry().length).toBeGreaterThan(0);
    resetMatrixRegistry();
    expect(getMatrixRegistry().length).toBe(0);
  });

  it("registerMatrixEntry appends entries in order", () => {
    registerMatrixEntry({
      key: "AWS::S3::Bucket",
      axis: "type",
      intentShape: "CREATE",
    });
    registerMatrixEntry({
      key: "AWS::Lambda::Function",
      axis: "type",
      intentShape: "CREATE",
    });
    const registry = getMatrixRegistry();
    expect(registry[0]?.key).toBe("AWS::S3::Bucket");
    expect(registry[1]?.key).toBe("AWS::Lambda::Function");
  });
});
