/**
 * Unit tests for plan-generator/placeholders.ts — focused on the SRP
 * behaviour of each exported helper, independent of the node wiring.
 */
import { describe, it, expect } from "vitest";
import {
  isTemplatePlaceholder,
  stripEmpty,
  stripPlaceholderArns,
  TEMPLATE_PLACEHOLDER_MARKERS,
} from "./placeholders.js";

describe("placeholders direct import", () => {
  describe("TEMPLATE_PLACEHOLDER_MARKERS", () => {
    it("includes the documented marker substrings", () => {
      for (const marker of [
        "my-",
        "your-",
        "...",
        "example",
        "12345",
        "(leave blank",
        "(auto-generated",
      ]) {
        expect(TEMPLATE_PLACEHOLDER_MARKERS).toContain(marker);
      }
    });
  });

  describe("isTemplatePlaceholder", () => {
    it("flags obvious template placeholders", () => {
      expect(isTemplatePlaceholder("my-bucket")).toBe(true);
      expect(isTemplatePlaceholder("your-role")).toBe(true);
      expect(isTemplatePlaceholder("arn:aws:iam::123456789012:role/...")).toBe(
        true,
      );
      expect(isTemplatePlaceholder("Brief description of the thing")).toBe(
        true,
      );
    });

    it("does NOT flag valid-shaped real values", () => {
      expect(isTemplatePlaceholder("10.0.1.0/24")).toBe(false);
      expect(isTemplatePlaceholder("index.handler")).toBe(false);
      expect(isTemplatePlaceholder("30")).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(isTemplatePlaceholder("MY-BUCKET")).toBe(true);
    });
  });

  describe("stripEmpty", () => {
    it("strips null, undefined, '' and []", () => {
      const result = stripEmpty({
        a: 1,
        b: null,
        c: undefined,
        d: "",
        e: [],
        f: "keep",
      });
      expect(result).toEqual({ a: 1, f: "keep" });
    });

    it("recursively strips nested empty objects", () => {
      const result = stripEmpty({ nested: { inner: "" }, keep: { x: 1 } });
      expect(result).toEqual({ keep: { x: 1 } });
    });

    it("strips string values that match the placeholder set", () => {
      const result = stripEmpty(
        { a: "my-bucket", b: "real-value" },
        new Set(["my-bucket"]),
      );
      expect(result).toEqual({ b: "real-value" });
    });
  });

  describe("stripPlaceholderArns", () => {
    it("removes ARNs with canonical AWS docs account ids", () => {
      const state = {
        AlarmActions: [
          "arn:aws:sns:us-east-1:123456789012:Topic",
          "arn:aws:sns:us-east-1:210987654321:Real",
        ],
      };
      stripPlaceholderArns(state);
      expect(state.AlarmActions).toEqual([
        "arn:aws:sns:us-east-1:210987654321:Real",
      ]);
    });

    it("deletes the field when every element is a placeholder", () => {
      const state: Record<string, unknown> = {
        AlarmActions: ["arn:aws:sns:us-east-1:123456789012:Topic"],
      };
      stripPlaceholderArns(state);
      expect(state["AlarmActions"]).toBeUndefined();
    });

    it("does not touch non-array fields", () => {
      const state = { Name: "arn:aws:sns:us-east-1:123456789012:X" };
      stripPlaceholderArns(state);
      expect(state.Name).toBe("arn:aws:sns:us-east-1:123456789012:X");
    });
  });
});
