/**
 * W3-04 — Account ID validator tests.
 */

import { describe, it, expect } from "vitest";
import {
  validateAccountId,
  PLACEHOLDER_ACCOUNT_IDS,
} from "./account-id-validator.js";

describe("validateAccountId — valid IDs", () => {
  it("accepts a valid 12-digit account ID", () => {
    const result = validateAccountId("111122223333");
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("accepts another valid 12-digit account ID", () => {
    expect(validateAccountId("999888777666").valid).toBe(true);
  });

  it("accepts GovCloud-style 12-digit account IDs (partition-agnostic)", () => {
    // GovCloud account IDs are still 12 numeric digits.
    expect(validateAccountId("012345678901").valid).toBe(true);
  });

  it("accepts China-region-style 12-digit account IDs", () => {
    expect(validateAccountId("543210987654").valid).toBe(true);
  });
});

describe("validateAccountId — format errors", () => {
  it("rejects ID with fewer than 12 digits", () => {
    const result = validateAccountId("1234567890");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("12 digits");
  });

  it("rejects ID with more than 12 digits", () => {
    const result = validateAccountId("1234567890123");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("12 digits");
  });

  it("rejects ID with non-numeric characters", () => {
    const result = validateAccountId("12345678901A");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("12 digits");
  });

  it("rejects empty string", () => {
    const result = validateAccountId("");
    expect(result.valid).toBe(false);
  });

  it("rejects ARN strings", () => {
    const result = validateAccountId("arn:aws:iam::111122223333:root");
    expect(result.valid).toBe(false);
  });

  it("rejects hyphenated IDs (e.g. with dashes)", () => {
    const result = validateAccountId("1111-2222-3333");
    expect(result.valid).toBe(false);
  });
});

describe("validateAccountId — placeholder rejection", () => {
  it("rejects the AWS docs placeholder 123456789012", () => {
    const result = validateAccountId("123456789012");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Placeholder account ID rejected");
  });

  it("rejects the project-internal redacted-test pattern 210987654321", () => {
    const result = validateAccountId("210987654321");
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Placeholder account ID rejected");
  });

  it("PLACEHOLDER_ACCOUNT_IDS contains both known placeholders", () => {
    expect(PLACEHOLDER_ACCOUNT_IDS.has("123456789012")).toBe(true);
    expect(PLACEHOLDER_ACCOUNT_IDS.has("210987654321")).toBe(true);
  });
});
