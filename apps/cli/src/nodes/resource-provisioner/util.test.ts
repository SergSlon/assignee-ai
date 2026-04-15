import { describe, it, expect } from "vitest";
import { formatErrorForLog, isResourceType, sanitizeKeyName } from "./util.js";

describe("resource-provisioner/util", () => {
  describe("isResourceType", () => {
    it("returns true for a supported CFN type", () => {
      expect(isResourceType("AWS::S3::Bucket")).toBe(true);
    });

    it("returns false for an unknown type", () => {
      expect(isResourceType("AWS::NoSuch::Type")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isResourceType("")).toBe(false);
    });
  });

  describe("formatErrorForLog", () => {
    it("returns stack when err is an Error with a stack", () => {
      const err = new Error("boom");
      const formatted = formatErrorForLog(err);
      expect(formatted).toContain("boom");
      expect(formatted).toContain("at ");
    });

    it("falls back to message when stack is undefined", () => {
      const err = new Error("only-message");
      err.stack = undefined;
      expect(formatErrorForLog(err)).toBe("only-message");
    });

    it("stringifies non-Error throws", () => {
      expect(formatErrorForLog("just a string")).toBe("just a string");
      expect(formatErrorForLog(42)).toBe("42");
      expect(formatErrorForLog(null)).toBe("null");
      expect(formatErrorForLog(undefined)).toBe("undefined");
    });

    it("preserves AWS SDK error subclass stacks", () => {
      class ThrottlingException extends Error {
        override name = "ThrottlingException";
      }
      const err = new ThrottlingException("rate exceeded");
      const formatted = formatErrorForLog(err);
      expect(formatted).toContain("rate exceeded");
    });
  });

  describe("sanitizeKeyName", () => {
    it("preserves safe characters", () => {
      expect(sanitizeKeyName("my-key_v1.2")).toBe("my-key_v1.2");
    });

    it("replaces path separators", () => {
      expect(sanitizeKeyName("../etc/passwd")).toBe("etc_passwd");
      expect(sanitizeKeyName("a\\b")).toBe("a_b");
    });

    it("replaces null bytes", () => {
      expect(sanitizeKeyName("a\0b")).toBe("a_b");
    });

    it("strips leading dots so result is never a dotfile", () => {
      expect(sanitizeKeyName(".hidden")).toBe("hidden");
      expect(sanitizeKeyName("..")).toBe("assignee_key");
      expect(sanitizeKeyName(".")).toBe("assignee_key");
    });

    it("replaces control chars and newlines", () => {
      expect(sanitizeKeyName("a\nb\tc")).toBe("a_b_c");
    });

    it("replaces shell metacharacters", () => {
      expect(sanitizeKeyName("key;rm -rf")).toBe("key_rm_-rf");
      expect(sanitizeKeyName("key$(whoami)")).toBe("key__whoami_");
    });

    it("replaces non-ASCII Unicode", () => {
      expect(sanitizeKeyName("café")).toBe("caf_");
    });

    it("returns placeholder for empty/all-stripped input", () => {
      expect(sanitizeKeyName("")).toBe("assignee_key");
      expect(sanitizeKeyName("///")).toBe("assignee_key");
      expect(sanitizeKeyName("...")).toBe("assignee_key");
    });
  });
});
