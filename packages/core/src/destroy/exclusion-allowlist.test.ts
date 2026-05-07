/**
 * Unit tests for the bulk-destroy exclusion allowlist.
 *
 * Verifies every pattern in EXCLUSION_ALLOWLIST against both matching
 * and non-matching ARNs. No AWS SDK imports — the allowlist module must
 * be testable in full isolation.
 */

import { describe, it, expect } from "vitest";
import {
  EXCLUSION_ALLOWLIST,
  findExclusion,
  isExcluded,
} from "./exclusion-allowlist.js";

// ── Sample ARNs that MUST be excluded ──────────────────────────────────

const EXCLUDED_ARNS = [
  // IAM Managed Policies (standard partition)
  "arn:aws:iam::123456789012:policy/AssigneeOperatorPolicy",
  "arn:aws:iam::123456789012:policy/AssigneeOperatorServicesAPolicy",
  "arn:aws:iam::123456789012:policy/AssigneeOperatorServicesBPolicy",
  "arn:aws:iam::123456789012:policy/AssigneeReaderPolicy",
  "arn:aws:iam::123456789012:policy/AssigneeAuditorPolicy",
  // IAM Managed Policies (GovCloud partition)
  "arn:aws-us-gov:iam::123456789012:policy/AssigneeOperatorPolicy",
  // IAM Managed Policies (China partition)
  "arn:aws-cn:iam::123456789012:policy/AssigneeReaderPolicy",
  // IAM Users
  "arn:aws:iam::123456789012:user/assignee-operator",
  "arn:aws:iam::123456789012:user/assignee-reader",
  "arn:aws:iam::123456789012:user/assignee-auditor",
  // IAM Roles
  "arn:aws:iam::123456789012:role/AssigneeOperator",
  "arn:aws:iam::123456789012:role/AssigneeReader",
  "arn:aws:iam::123456789012:role/AssigneeAuditor",
  "arn:aws:iam::123456789012:role/AssigneeAiBedrockLoggingRole",
];

// ── Sample ARNs that must NOT be excluded ──────────────────────────────

const ALLOWED_ARNS = [
  // Regular S3 bucket — not protected
  "arn:aws:s3:::my-data-bucket",
  // EC2 instance
  "arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0",
  // Lambda function
  "arn:aws:lambda:us-east-1:123456789012:function:my-function",
  // An IAM policy with a similar but NOT matching name
  "arn:aws:iam::123456789012:policy/AssigneeCustomPolicy",
  "arn:aws:iam::123456789012:policy/NotAssigneeOperatorPolicy",
  // A user with a partial name match
  "arn:aws:iam::123456789012:user/assignee-operator-legacy",
  "arn:aws:iam::123456789012:user/another-assignee-reader",
  // Role with a partial name match
  "arn:aws:iam::123456789012:role/MyAssigneeOperator",
  "arn:aws:iam::123456789012:role/AssigneeAiBedrockLoggingRoleOld",
  // KMS key
  "arn:aws:kms:us-east-1:123456789012:key/mrk-12345678",
  // DynamoDB table
  "arn:aws:dynamodb:us-east-1:123456789012:table/my-table",
  // SecretsManager secret
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret-abc123",
];

// ── Tests ──────────────────────────────────────────────────────────────

describe("EXCLUSION_ALLOWLIST", () => {
  it("has at least 12 entries (5 policies + 3 users + 4 roles)", () => {
    // 5 IAM managed policies + 3 IAM users + 4 IAM roles = 12
    expect(EXCLUSION_ALLOWLIST.length).toBeGreaterThanOrEqual(12);
  });

  it("every entry has a non-empty arnPattern and reason", () => {
    for (const entry of EXCLUSION_ALLOWLIST) {
      expect(entry.arnPattern).toBeInstanceOf(RegExp);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("isExcluded", () => {
  it.each(EXCLUDED_ARNS)("blocks %s", (arn) => {
    expect(isExcluded(arn)).toBe(true);
  });

  it.each(ALLOWED_ARNS)("allows %s", (arn) => {
    expect(isExcluded(arn)).toBe(false);
  });
});

describe("findExclusion", () => {
  it("returns entry with reason for a protected ARN", () => {
    const entry = findExclusion(
      "arn:aws:iam::123456789012:policy/AssigneeOperatorPolicy",
    );
    expect(entry).toBeDefined();
    expect(entry!.reason).toMatch(/AssigneeOperatorPolicy/);
  });

  it("returns undefined for a non-protected ARN", () => {
    const entry = findExclusion("arn:aws:s3:::my-bucket");
    expect(entry).toBeUndefined();
  });

  it("returns the matching entry for each protected policy name", () => {
    const policyNames = [
      "AssigneeOperatorPolicy",
      "AssigneeOperatorServicesAPolicy",
      "AssigneeOperatorServicesBPolicy",
      "AssigneeReaderPolicy",
      "AssigneeAuditorPolicy",
    ];
    for (const name of policyNames) {
      const arn = `arn:aws:iam::112233445566:policy/${name}`;
      const entry = findExclusion(arn);
      expect(entry, `expected entry for ${arn}`).toBeDefined();
    }
  });

  it("returns the matching entry for each protected user name", () => {
    const userNames = [
      "assignee-operator",
      "assignee-reader",
      "assignee-auditor",
    ];
    for (const name of userNames) {
      const arn = `arn:aws:iam::112233445566:user/${name}`;
      const entry = findExclusion(arn);
      expect(entry, `expected entry for ${arn}`).toBeDefined();
    }
  });

  it("returns the matching entry for each protected role name", () => {
    const roleNames = [
      "AssigneeOperator",
      "AssigneeReader",
      "AssigneeAuditor",
      "AssigneeAiBedrockLoggingRole",
    ];
    for (const name of roleNames) {
      const arn = `arn:aws:iam::112233445566:role/${name}`;
      const entry = findExclusion(arn);
      expect(entry, `expected entry for ${arn}`).toBeDefined();
    }
  });

  it("does not exclude an ARN that is merely a prefix of a protected ARN", () => {
    // AssigneeOperator should not match AssigneeOperatorPolicy
    const entry = findExclusion(
      "arn:aws:iam::112233445566:role/AssigneeOperatorPolicy",
    );
    expect(entry).toBeUndefined();
  });

  it("does not exclude partial user name matches", () => {
    // assignee-reader-v2 should not match assignee-reader
    expect(
      isExcluded("arn:aws:iam::112233445566:user/assignee-reader-v2"),
    ).toBe(false);
  });

  it("works for GovCloud partition ARNs", () => {
    expect(
      isExcluded(
        "arn:aws-us-gov:iam::112233445566:policy/AssigneeOperatorPolicy",
      ),
    ).toBe(true);
  });

  it("works for China partition ARNs", () => {
    expect(
      isExcluded("arn:aws-cn:iam::112233445566:policy/AssigneeAuditorPolicy"),
    ).toBe(true);
  });

  it("allows empty string ARN (no match)", () => {
    expect(isExcluded("")).toBe(false);
  });
});
