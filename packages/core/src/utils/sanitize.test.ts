import { describe, it, expect } from "vitest";
import { sanitizeUserIntent, MAX_INTENT_LENGTH } from "./sanitize.js";

describe("sanitizeUserIntent", () => {
  it("truncates input over 500 chars to MAX_INTENT_LENGTH", () => {
    const input = "a".repeat(600);
    const result = sanitizeUserIntent(input);
    expect(result).toHaveLength(MAX_INTENT_LENGTH);
    expect(result).toBe("a".repeat(500));
  });

  it("removes null bytes", () => {
    const result = sanitizeUserIntent("create\0bucket\0");
    expect(result).toBe("createbucket");
  });

  it("removes Unicode direction-override characters (U+202E RTL override)", () => {
    const result = sanitizeUserIntent("safe\u202Emalicious");
    expect(result).toBe("safemalicious");
  });

  it("removes all Unicode direction-override/isolate characters", () => {
    const chars = [
      "\u200E",
      "\u200F",
      "\u202A",
      "\u202B",
      "\u202C",
      "\u202D",
      "\u202E",
      "\u2066",
      "\u2067",
      "\u2068",
      "\u2069",
    ];
    for (const ch of chars) {
      expect(sanitizeUserIntent(`before${ch}after`)).toBe("beforeafter");
    }
  });

  it("escapes ${ template-injectable sequences", () => {
    const result = sanitizeUserIntent("${SECRET}");
    expect(result).toBe("$ {SECRET}");
  });

  it("leaves normal intent unchanged", () => {
    const intent = "create an S3 bucket";
    expect(sanitizeUserIntent(intent)).toBe(intent);
  });

  it("preserves emoji in intent", () => {
    const intent = "create 🪣 bucket";
    expect(sanitizeUserIntent(intent)).toBe(intent);
  });

  it("preserves \\n, \\t, and \\r characters", () => {
    const intent = "line1\nline2\ttabbed\r";
    expect(sanitizeUserIntent(intent)).toBe(intent);
  });

  it("removes control characters (BEL U+0007)", () => {
    expect(sanitizeUserIntent("a\x07b")).toBe("ab");
  });

  it("removes control characters (ESC U+001B)", () => {
    expect(sanitizeUserIntent("a\x1Bb")).toBe("ab");
  });

  it("removes control characters (SOH U+0001)", () => {
    expect(sanitizeUserIntent("a\x01b")).toBe("ab");
  });

  it("removes DEL character (U+007F)", () => {
    expect(sanitizeUserIntent("a\x7Fb")).toBe("ab");
  });
});
