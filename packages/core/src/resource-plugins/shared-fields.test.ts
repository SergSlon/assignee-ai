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

  // Tier C: dropped redundant toBeDefined() — toMatch with a precise
  // pattern is strictly stronger than the toBeDefined+toContain combo.
  it("rejects backslash in tag value with charset error", () => {
    const result = TAGS_VALIDATE("env:prod\\test");
    expect(result).toMatch(
      /Tag value "[^"]*" contains invalid characters\. Allowed:/,
    );
  });

  it("rejects quotes in tag value with charset error", () => {
    // The error message embeds the offending value, which itself contains
    // quotes here — match on the stable suffix instead.
    const result = TAGS_VALIDATE('name:"quoted"');
    expect(result).toMatch(/contains invalid characters\. Allowed:/);
  });

  it("rejects tab and newline in tag value with charset error", () => {
    const result = TAGS_VALIDATE("env:prod\ttest");
    expect(result).toMatch(
      /Tag value "[^"]*" contains invalid characters\. Allowed:/,
    );
  });

  it("rejects tag key exceeding 128 characters with length error", () => {
    const result = TAGS_VALIDATE("a".repeat(129) + ":val");
    expect(result).toMatch(/Tag key "[^"]*" exceeds 128 character limit/);
  });

  it("rejects tag value exceeding 256 characters with length error", () => {
    const result = TAGS_VALIDATE("key:" + "a".repeat(257));
    expect(result).toBe('Tag value for "key" exceeds 256 character limit');
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

  it("rejects tag missing colon separator with format error", () => {
    // Tier C: strengthened — assert the full error message
    const result = TAGS_VALIDATE("novalue");
    expect(result).toBe(
      "Invalid tag format. Use Key:Value pairs separated by commas (e.g. env:production, team:backend)",
    );
  });
});
