/**
 * Unit tests for plan-generator/safe-clone.ts — direct-import sanity
 * checks that complement the broader plan-generator.safeClone.test.ts
 * which imports via the facade re-export.
 */
import { describe, it, expect } from "vitest";
import { redactResourceId, safeCloneDesiredState } from "./safe-clone.js";

describe("safe-clone direct import", () => {
  describe("redactResourceId", () => {
    it("returns short ids verbatim", () => {
      expect(redactResourceId("my-bucket")).toBe("my-bucket");
    });

    it("redacts long ids to 32 chars + sha suffix, stable across calls", () => {
      const longId = "a".repeat(50);
      const first = redactResourceId(longId);
      const second = redactResourceId(longId);
      expect(first).toBe(second);
      expect(first.startsWith("a".repeat(32))).toBe(true);
      expect(first).toMatch(/…#[0-9a-f]{8}$/);
    });

    it("uses the 32-char boundary exclusively (<= 32 verbatim, 33 redacted)", () => {
      expect(redactResourceId("a".repeat(32))).toBe("a".repeat(32));
      expect(redactResourceId("a".repeat(33))).not.toBe("a".repeat(33));
    });
  });

  describe("safeCloneDesiredState", () => {
    it("deep-clones plain objects", () => {
      const input = { a: 1, nested: { b: [2, 3] } };
      const clone = safeCloneDesiredState(input, "r");
      expect(clone).toEqual(input);
      expect(clone).not.toBe(input);
      expect(clone["nested"]).not.toBe(input.nested);
    });

    it("rejects arrays with a TypeError", () => {
      expect(() => safeCloneDesiredState([1, 2] as unknown, "r")).toThrow(
        /must be a plain object/,
      );
    });

    it("rejects null with a TypeError", () => {
      expect(() => safeCloneDesiredState(null, "r")).toThrow(
        /must be a plain object/,
      );
    });

    it("wraps DataCloneError with actionable hint for non-serializable values", () => {
      const withFn = { fn: () => "boom" };
      expect(() => safeCloneDesiredState(withFn, "r")).toThrow(
        /non-serializable value/,
      );
    });
  });
});
