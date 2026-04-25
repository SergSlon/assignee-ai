/**
 * Unit tests for arn-redactor.ts (W10-07 / P051 → L3-F16).
 *
 * All test ARNs use the synthetic account IDs mandated by
 * feedback_no_real_account_ids_in_repo.md:
 *   210987654321 — used for non-denylisted test ARNs
 *   123456789012 — docs / placeholder examples
 */
import { describe, it, expect } from "vitest";
import {
  redactArn,
  redactArnsInString,
  REDACTED_ACCOUNT_ID,
  REDACTED_RESOURCE,
} from "./arn-redactor.js";

// ── redactArn ─────────────────────────────────────────────────────────────────

describe("redactArn", () => {
  it("passes through non-ARN strings unchanged", () => {
    expect(redactArn("hello world")).toBe("hello world");
    expect(redactArn("")).toBe("");
  });

  it("scrubs 12-digit account ID → REDACTED_ACCOUNT_ID", () => {
    const result = redactArn("arn:aws:iam::210987654321:user/test");
    expect(result).toContain(REDACTED_ACCOUNT_ID);
    expect(result).not.toContain("210987654321");
  });

  it("preserves ARN partition and service after account redaction", () => {
    const result = redactArn("arn:aws:iam::210987654321:user/test");
    expect(result).toMatch(/^arn:aws:iam::/);
  });

  it("redacts user resource (not allowlisted) → REDACTED_RESOURCE", () => {
    const result = redactArn("arn:aws:iam::210987654321:user/test");
    expect(result).toContain(REDACTED_RESOURCE);
    expect(result).not.toContain("user/test");
    // Preserve service prefix
    expect(result).toContain(REDACTED_ACCOUNT_ID);
  });

  it("allowlists role/ prefix — keeps role type, redacts name only", () => {
    const result = redactArn("arn:aws:iam::210987654321:role/LambdaExecRole");
    expect(result).toContain(REDACTED_ACCOUNT_ID);
    expect(result).toContain("role/");
    expect(result).not.toContain("LambdaExecRole");
    expect(result).toContain(REDACTED_RESOURCE);
  });

  it("allowlists instance-profile/ prefix", () => {
    const result = redactArn(
      "arn:aws:iam::210987654321:instance-profile/MyProfile",
    );
    expect(result).toContain("instance-profile/");
    expect(result).not.toContain("MyProfile");
  });

  it("allowlists policy/ prefix", () => {
    const result = redactArn("arn:aws:iam::210987654321:policy/MyPolicy");
    expect(result).toContain("policy/");
    expect(result).not.toContain("MyPolicy");
  });

  it("redacts S3 bucket ARN resource (no account-id in S3 ARNs)", () => {
    // S3 ARNs have no account-id field: arn:aws:s3:::bucket-name
    const result = redactArn("arn:aws:s3:::sensitive-customer-bucket-12345");
    expect(result).not.toContain("sensitive-customer-bucket-12345");
    expect(result).toContain(REDACTED_RESOURCE);
    // partition + service preserved
    expect(result).toMatch(/^arn:aws:s3:::/);
  });

  it("redacts Lambda ARN account ID", () => {
    const result = redactArn(
      "arn:aws:lambda:us-east-1:210987654321:function:my-fn",
    );
    expect(result).toContain(REDACTED_ACCOUNT_ID);
    expect(result).not.toContain("210987654321");
  });

  it("is partition-aware: handles aws-us-gov partition", () => {
    const result = redactArn("arn:aws-us-gov:iam::210987654321:role/GovRole");
    expect(result).toMatch(/^arn:aws-us-gov:iam::/);
    expect(result).toContain(REDACTED_ACCOUNT_ID);
    expect(result).toContain("role/");
  });

  it("is partition-aware: handles aws-cn partition", () => {
    const result = redactArn("arn:aws-cn:s3:::cn-customer-bucket");
    expect(result).toMatch(/^arn:aws-cn:s3:::/);
    expect(result).not.toContain("cn-customer-bucket");
  });

  it("handles SQS queue ARN (account ID redacted, resource redacted)", () => {
    const result = redactArn("arn:aws:sqs:us-east-1:210987654321:my-queue");
    expect(result).toContain(REDACTED_ACCOUNT_ID);
    expect(result).not.toContain("my-queue");
  });

  it("handles SNS topic ARN", () => {
    const result = redactArn("arn:aws:sns:us-east-1:210987654321:my-topic");
    expect(result).toContain(REDACTED_ACCOUNT_ID);
    expect(result).not.toContain("my-topic");
  });

  it("does NOT alter a non-arn: prefix string", () => {
    expect(redactArn("https://example.com/arn")).toBe(
      "https://example.com/arn",
    );
  });
});

// ── redactArnsInString ────────────────────────────────────────────────────────

describe("redactArnsInString", () => {
  it("passes through strings with no ARNs unchanged", () => {
    const text = "Create an S3 bucket named my-bucket in us-east-1";
    expect(redactArnsInString(text)).toBe(text);
  });

  it("redacts an inline ARN within a prompt string", () => {
    const text =
      "The role arn:aws:iam::210987654321:role/MyRole should have access";
    const result = redactArnsInString(text);
    expect(result).not.toContain("210987654321");
    expect(result).toContain("The role arn:aws:iam::");
    expect(result).toContain("role/");
    expect(result).toContain("should have access");
  });

  it("redacts multiple ARNs in the same string", () => {
    const text = [
      "Use arn:aws:s3:::sensitive-bucket and",
      "arn:aws:iam::210987654321:user/admin",
    ].join(" ");
    const result = redactArnsInString(text);
    expect(result).not.toContain("sensitive-bucket");
    expect(result).not.toContain("210987654321");
    expect(result).toContain("Use arn:aws:s3:::");
    expect(result).toContain("and arn:aws:iam::");
  });

  it("preserves surrounding prose (non-ARN content not altered)", () => {
    const text =
      "Error: arn:aws:lambda:us-east-1:210987654321:function:my-fn failed";
    const result = redactArnsInString(text);
    expect(result).toMatch(/^Error: /);
    expect(result).toMatch(/ failed$/);
  });

  it("handles empty string", () => {
    expect(redactArnsInString("")).toBe("");
  });

  it("handles SQS ARN in error messages (from intent-parser ARN extraction)", () => {
    // Regression: intent-parser extracts SQS ARNs from user intent and
    // passes them as elicitedOptions. This test confirms the redactor
    // works on those tokens.
    const text =
      "Set dead-letter queue to arn:aws:sqs:us-east-1:210987654321:my-dlq";
    const result = redactArnsInString(text);
    expect(result).not.toContain("210987654321");
    expect(result).not.toContain("my-dlq");
  });
});
