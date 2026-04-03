import { describe, it, expect } from "vitest";
import { TAGS_VALIDATE } from "./shared-fields.js";

describe("TAGS_VALIDATE", () => {
  it("accepts valid comma-separated Key:Value tags", () => {
    expect(TAGS_VALIDATE("env:production, team:backend")).toBeUndefined();
  });

  it("accepts special characters allowed by AWS (+ _ / @)", () => {
    expect(TAGS_VALIDATE("cost+center:team_a")).toBeUndefined();
    expect(TAGS_VALIDATE("path:/app/@v2")).toBeUndefined();
    expect(TAGS_VALIDATE("dash-key:under_val")).toBeUndefined();
  });

  it("rejects backslash in tag value", () => {
    const result = TAGS_VALIDATE("env:prod\\test");
    expect(result).toBeDefined();
    expect(result).toContain("invalid characters");
  });

  it("rejects quotes in tag value", () => {
    const result = TAGS_VALIDATE('name:"quoted"');
    expect(result).toBeDefined();
    expect(result).toContain("invalid characters");
  });

  it("rejects tab and newline in tag value", () => {
    const result = TAGS_VALIDATE("env:prod\ttest");
    expect(result).toBeDefined();
    expect(result).toContain("invalid characters");
  });

  it("rejects tag key exceeding 128 characters", () => {
    const result = TAGS_VALIDATE("a".repeat(129) + ":val");
    expect(result).toBeDefined();
    expect(result).toContain("128");
  });

  it("rejects tag value exceeding 256 characters", () => {
    const result = TAGS_VALIDATE("key:" + "a".repeat(257));
    expect(result).toBeDefined();
    expect(result).toContain("256");
  });

  it("accepts tag key at exactly 128 characters", () => {
    expect(TAGS_VALIDATE("a".repeat(128) + ":val")).toBeUndefined();
  });

  it("returns undefined for empty, null, and undefined input", () => {
    expect(TAGS_VALIDATE("")).toBeUndefined();
    expect(TAGS_VALIDATE(null)).toBeUndefined();
    expect(TAGS_VALIDATE(undefined)).toBeUndefined();
  });

  it("accepts colons in tag value (e.g. ARN format)", () => {
    expect(TAGS_VALIDATE("arn:aws:s3:::bucket")).toBeUndefined();
  });

  it("rejects tag missing colon separator", () => {
    const result = TAGS_VALIDATE("novalue");
    expect(result).toBeDefined();
    expect(result).toContain("format");
  });
});
