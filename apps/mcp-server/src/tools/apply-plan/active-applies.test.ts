import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetActiveApplies,
  MAX_ACTIVE_APPLIES,
  clearAllApplies,
  isApplyActive,
  markApplyActive,
  releaseApply,
} from "./active-applies.js";

describe("active-applies concurrency guard", () => {
  afterEach(() => {
    _resetActiveApplies();
  });

  it("mark/is/release happy path tracks the checkpoint path", () => {
    const path = "/tmp/checkpoint-happy.json";

    expect(isApplyActive(path)).toBe(false);

    markApplyActive(path);
    expect(isApplyActive(path)).toBe(true);

    releaseApply(path);
    expect(isApplyActive(path)).toBe(false);
  });

  it("release-then-remark under the cap works", () => {
    const path = "/tmp/checkpoint-cycle.json";

    markApplyActive(path);
    releaseApply(path);
    expect(isApplyActive(path)).toBe(false);

    // Re-mark after release should succeed without throwing.
    expect(() => markApplyActive(path)).not.toThrow();
    expect(isApplyActive(path)).toBe(true);
  });

  it("marking MAX_ACTIVE_APPLIES distinct paths succeeds; the next one throws", () => {
    for (let index = 0; index < MAX_ACTIVE_APPLIES; index += 1) {
      markApplyActive(`/tmp/checkpoint-${index}.json`);
    }

    const overflowPath = `/tmp/checkpoint-${MAX_ACTIVE_APPLIES}.json`;
    // Story 56-it2-04 L5-L1: message includes the rejected checkpointPath.
    expect(() => markApplyActive(overflowPath)).toThrow(
      `Active-applies cap reached (${MAX_ACTIVE_APPLIES}); rejected checkpoint "${overflowPath}". This likely indicates a release leak; check apply-plan handler for missing finally/release paths.`,
    );

    // Re-marking an already-active path at the cap is idempotent and
    // must not throw — only genuinely new entries are rejected.
    expect(() => markApplyActive("/tmp/checkpoint-0.json")).not.toThrow();
  });

  it("releasing one entry at the cap frees a slot for a new apply", () => {
    for (let index = 0; index < MAX_ACTIVE_APPLIES; index += 1) {
      markApplyActive(`/tmp/checkpoint-${index}.json`);
    }

    expect(() => markApplyActive("/tmp/checkpoint-new.json")).toThrow();

    releaseApply("/tmp/checkpoint-0.json");

    expect(() => markApplyActive("/tmp/checkpoint-new.json")).not.toThrow();
    expect(isApplyActive("/tmp/checkpoint-new.json")).toBe(true);
  });

  // Story 56-it2-04 L3-L1: ASSIGNEE_MCP_MAX_ACTIVE_APPLIES overrides the
  // default. Evaluated at module-load, so we re-import through vi.resetModules.
  describe("ASSIGNEE_MCP_MAX_ACTIVE_APPLIES env override (L3-L1)", () => {
    const ENV_KEY = "ASSIGNEE_MCP_MAX_ACTIVE_APPLIES";
    const origValue = process.env[ENV_KEY];

    afterEach(() => {
      if (origValue === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = origValue;
      }
      vi.resetModules();
    });

    it("defaults to 100 when env var is unset", async () => {
      delete process.env[ENV_KEY];
      vi.resetModules();
      const mod = await import("./active-applies.js");
      expect(mod.MAX_ACTIVE_APPLIES).toBe(mod.DEFAULT_MAX_ACTIVE_APPLIES);
      expect(mod.DEFAULT_MAX_ACTIVE_APPLIES).toBe(100);
    });

    it("honours a positive integer override", async () => {
      process.env[ENV_KEY] = "250";
      vi.resetModules();
      const mod = await import("./active-applies.js");
      expect(mod.MAX_ACTIVE_APPLIES).toBe(250);
    });

    it("falls back to default on non-numeric value (typo-safe)", async () => {
      process.env[ENV_KEY] = "not-a-number";
      vi.resetModules();
      const mod = await import("./active-applies.js");
      expect(mod.MAX_ACTIVE_APPLIES).toBe(mod.DEFAULT_MAX_ACTIVE_APPLIES);
    });

    it("falls back to default on zero / negative values (guard never disabled)", async () => {
      process.env[ENV_KEY] = "0";
      vi.resetModules();
      let mod = await import("./active-applies.js");
      expect(mod.MAX_ACTIVE_APPLIES).toBe(mod.DEFAULT_MAX_ACTIVE_APPLIES);

      process.env[ENV_KEY] = "-5";
      vi.resetModules();
      mod = await import("./active-applies.js");
      expect(mod.MAX_ACTIVE_APPLIES).toBe(mod.DEFAULT_MAX_ACTIVE_APPLIES);
    });

    it("falls back to default on fractional values (integer required)", async () => {
      process.env[ENV_KEY] = "42.5";
      vi.resetModules();
      const mod = await import("./active-applies.js");
      expect(mod.MAX_ACTIVE_APPLIES).toBe(mod.DEFAULT_MAX_ACTIVE_APPLIES);
    });

    it("trims surrounding whitespace before parsing", async () => {
      process.env[ENV_KEY] = "  42  ";
      vi.resetModules();
      const mod = await import("./active-applies.js");
      expect(mod.MAX_ACTIVE_APPLIES).toBe(42);
    });
  });

  it("_resetActiveApplies clears all tracked entries", () => {
    markApplyActive("/tmp/checkpoint-a.json");
    markApplyActive("/tmp/checkpoint-b.json");
    expect(isApplyActive("/tmp/checkpoint-a.json")).toBe(true);
    expect(isApplyActive("/tmp/checkpoint-b.json")).toBe(true);

    _resetActiveApplies();

    expect(isApplyActive("/tmp/checkpoint-a.json")).toBe(false);
    expect(isApplyActive("/tmp/checkpoint-b.json")).toBe(false);

    // After reset, we can fill the set from scratch up to the cap.
    for (let index = 0; index < MAX_ACTIVE_APPLIES; index += 1) {
      markApplyActive(`/tmp/checkpoint-post-reset-${index}.json`);
    }
    expect(() =>
      markApplyActive("/tmp/checkpoint-post-reset-overflow.json"),
    ).toThrow();
  });

  // ---------------------------------------------------------------------------
  // W6-S1 (M-β-14 + M-β-16): clearAllApplies — crash-path cleanup for the
  // signal handler.  Tests confirm that:
  //   (a) clearAllApplies() empties the set even with multiple in-flight applies
  //   (b) after clearAllApplies() a new apply is accepted (no stale lock blocks it)
  //   (c) clearAllApplies() is a no-op on an already-empty set
  // ---------------------------------------------------------------------------
  describe("clearAllApplies (W6-S1 signal-handler crash-path cleanup)", () => {
    afterEach(() => {
      _resetActiveApplies();
    });

    it("clears all in-flight apply locks when called during simulated signal shutdown", () => {
      const paths = [
        "/tmp/apply-flight-1.json",
        "/tmp/apply-flight-2.json",
        "/tmp/apply-flight-3.json",
      ];

      for (const p of paths) {
        markApplyActive(p);
      }
      for (const p of paths) {
        expect(isApplyActive(p)).toBe(true);
      }

      // Simulate what the signal handler does before process.exit().
      clearAllApplies();

      for (const p of paths) {
        expect(isApplyActive(p)).toBe(false);
      }
    });

    it("after clearAllApplies, a fresh apply on the same checkpoint is accepted (no stale-lock)", () => {
      const path = "/tmp/apply-was-in-flight.json";

      markApplyActive(path);
      expect(isApplyActive(path)).toBe(true);

      // Signal fires — crash-path cleanup runs.
      clearAllApplies();

      expect(isApplyActive(path)).toBe(false);

      // A new process invocation (or the same process after restart) marks
      // the checkpoint active again — must not throw.
      expect(() => markApplyActive(path)).not.toThrow();
      expect(isApplyActive(path)).toBe(true);
    });

    it("clearAllApplies is a no-op on an already-empty set", () => {
      // Precondition: set is empty.
      expect(() => clearAllApplies()).not.toThrow();
    });

    it("activeApplies.size === 0 after clearAllApplies with applies at the cap", () => {
      // Fill the set to the cap.
      for (let index = 0; index < MAX_ACTIVE_APPLIES; index += 1) {
        markApplyActive(`/tmp/cap-path-${index}.json`);
      }
      // Verify we're at the cap — the next mark would throw.
      expect(() => markApplyActive("/tmp/overflow.json")).toThrow();

      clearAllApplies();

      // Set is empty — the overflow path should now succeed.
      expect(() => markApplyActive("/tmp/overflow.json")).not.toThrow();
      expect(isApplyActive("/tmp/overflow.json")).toBe(true);
    });
  });
});
