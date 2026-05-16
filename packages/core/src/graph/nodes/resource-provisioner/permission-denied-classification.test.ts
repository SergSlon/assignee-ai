/**
 * Regression tests for DF-A4/D6 fix — PERMISSION_DENIED / AccessDeniedException
 * classification in the `classifyCreateError` dispatch table.
 *
 * Dogfood finding (2026-05-11): CloudControl API PERMISSION_DENIED errors
 * surfaced as the raw unhandled string "An unclassified error was encountered.
 * This may be a bug" because the ACCESS_DENIED ProvisioningErrorKind was mapped
 * to PROVISIONING_ERROR_CODES.UNKNOWN instead of PROVISIONING_ERROR_CODES.ACCESS_DENIED,
 * and the enricher did not include the `assignee audit-verify` actionable hint.
 *
 * These tests FAIL against the pre-fix code (ACCESS_DENIED mapped to UNKNOWN,
 * no `assignee audit-verify` in the hint) and PASS after the fix.
 *
 * Story 108-A-02 — Probe axes exercised:
 *   Axis I — PERMISSION_DENIED / AccessDeniedException error code classification
 *   Axis J — Other error codes unaffected (regression check)
 *   Axis K — Unknown error code fallthrough does not throw
 */

import { describe, it, expect } from "vitest";
import { PROVISIONING_ERROR_CODES } from "@/errors.js";
import { ProvisioningErrorKind } from "@/ports/provisioning-port.js";
import { classifyCreateError } from "./error-classifier.js";

// Gap-7 harness exception: axes here are keyed by the ProvisioningErrorKind enum
// (5 values + edge cases), NOT by resource type — so enumerateTypes() doesn't apply.
// See _archive/reviews/<sha>-review.md F3 for rationale.

// ---------------------------------------------------------------------------
// Axis I — PERMISSION_DENIED → ACCESS_DENIED code + assignee audit-verify hint
// ---------------------------------------------------------------------------

describe("DF-A4/D6 — ACCESS_DENIED kind → PERMISSION_DENIED structured classification", () => {
  it("Axis I-1: bare AccessDeniedException maps to ACCESS_DENIED errorCode", () => {
    // Pre-fix: errorCode was PROVISIONING_ERROR_CODES.UNKNOWN
    // Post-fix: must be PROVISIONING_ERROR_CODES.ACCESS_DENIED
    const result = classifyCreateError(
      {
        kind: ProvisioningErrorKind.ACCESS_DENIED,
        message:
          "AccessDeniedException: User: arn:aws:iam::112233445566:user/assignee-operator is not authorized to perform: cloudcontrol:CreateResource on resource: AWS::Lambda::Function",
      },
      "AWS::Lambda::Function",
    );

    expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.ACCESS_DENIED);
  });

  it("Axis I-2: bare AccessDeniedException hint contains `assignee audit-verify`", () => {
    const result = classifyCreateError(
      {
        kind: ProvisioningErrorKind.ACCESS_DENIED,
        message:
          "AccessDeniedException: User: arn:aws:iam::112233445566:user/assignee-operator is not authorized to perform: cloudcontrol:CreateResource on resource: AWS::RDS::DBInstance",
      },
      "AWS::RDS::DBInstance",
    );

    expect(result.userPrefix).toContain("assignee audit-verify");
    expect(result.shortMessage).toContain("assignee audit-verify");
  });

  it("Axis I-3: PERMISSION_DENIED literal in message triggers structured classification", () => {
    const rawMsg =
      "User: arn:aws:iam::112233445566:user/assignee-operator is not authorized to perform: iam:CreateRole on resource: *";
    const result = classifyCreateError(
      {
        kind: ProvisioningErrorKind.ACCESS_DENIED,
        message: rawMsg,
      },
      "AWS::IAM::Role",
    );

    expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.ACCESS_DENIED);
    // NOT_AUTHORIZED_SUBSTRING path also surfaces `assignee setup`
    expect(result.userPrefix).toContain("assignee setup");
    // Raw AWS message preserved
    expect(result.userPrefix).toContain(rawMsg);
    expect(result.shortMessage).toContain(rawMsg);
  });

  it("Axis I-4: raw AWS message always preserved in both userPrefix and shortMessage", () => {
    const rawMsg =
      "AccessDeniedException: User arn:aws:iam::112233445566:user/assignee-operator is not authorized to perform: ec2:DescribeVpcs";
    const result = classifyCreateError(
      {
        kind: ProvisioningErrorKind.ACCESS_DENIED,
        message: rawMsg,
      },
      "AWS::EC2::VPC",
    );

    // Raw message present in both surfaces (for grep / AWS support tickets)
    expect(result.userPrefix).toContain(rawMsg);
    expect(result.shortMessage).toContain(rawMsg);
    // Neither surface equals just the raw message (hint was prepended)
    expect(result.userPrefix).not.toBe(rawMsg);
    expect(result.shortMessage).not.toBe(rawMsg);
  });

  it("Axis I-5: iam:CreateRole ACCESS_DENIED for Lambda (DF-D5 intersection) is classified correctly", () => {
    // This is the dogfood DF-D5 × DF-A4 intersection: operator lacks iam:CreateRole
    // for the Lambda auto-role compound, CCAPI returns ACCESS_DENIED.
    const rawMsg =
      "User: arn:aws:iam::112233445566:user/assignee-operator is not authorized to perform: iam:CreateRole on resource: arn:aws:iam::112233445566:role/assignee-iam-execution-role-abc123";
    const result = classifyCreateError(
      {
        kind: ProvisioningErrorKind.ACCESS_DENIED,
        message: rawMsg,
      },
      "AWS::IAM::Role",
    );

    expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.ACCESS_DENIED);
    // Must contain the actionable hint for IAM permission gaps
    expect(result.userPrefix).toMatch(/assignee setup|assignee audit-verify/);
  });
});

// ---------------------------------------------------------------------------
// Axis J — other error codes unaffected (regression check)
// ---------------------------------------------------------------------------

describe("DF-A4/D6 — other error codes unaffected after ACCESS_DENIED fix", () => {
  it("Axis J-1: ALREADY_EXISTS still maps to ALREADY_EXISTS errorCode", () => {
    const result = classifyCreateError(
      {
        kind: ProvisioningErrorKind.ALREADY_EXISTS,
        message: "Resource already exists.",
      },
      "AWS::S3::Bucket",
    );

    expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.ALREADY_EXISTS);
  });

  it("Axis J-2: THROTTLED still maps to THROTTLED errorCode", () => {
    const result = classifyCreateError(
      {
        kind: ProvisioningErrorKind.THROTTLED,
        message: "Rate exceeded",
      },
      "AWS::EC2::Instance",
    );

    expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.THROTTLED);
    expect(result.userPrefix).toBe(
      "Request throttled by AWS. Please wait and retry.",
    );
  });

  it("Axis J-3: NOT_FOUND still maps to UNKNOWN errorCode (no change)", () => {
    const result = classifyCreateError(
      {
        kind: ProvisioningErrorKind.NOT_FOUND,
        message: "VpcId vpc-000 does not exist.",
      },
      "AWS::EC2::Subnet",
    );

    expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.UNKNOWN);
    expect(result.userPrefix).toBe("VpcId vpc-000 does not exist.");
  });

  it("Axis J-4: SERVICE_ERROR with unrelated message still maps to UNKNOWN + raw text", () => {
    const rawMsg = "Internal service error, please retry.";
    const result = classifyCreateError(
      {
        kind: ProvisioningErrorKind.SERVICE_ERROR,
        message: rawMsg,
      },
      "AWS::Lambda::Function",
    );

    expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.UNKNOWN);
    expect(result.userPrefix).toBe(rawMsg);
  });

  it("Axis J-5: UNKNOWN kind with unrelated message still maps to UNKNOWN + raw text", () => {
    const rawMsg = "Unable to locate credentials.";
    const result = classifyCreateError(
      {
        kind: ProvisioningErrorKind.UNKNOWN,
        message: rawMsg,
      },
      "AWS::IAM::Role",
    );

    expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.UNKNOWN);
    expect(result.userPrefix).toBe(rawMsg);
  });
});

// ---------------------------------------------------------------------------
// Axis K — fallthrough does not throw on unrecognized inputs
// ---------------------------------------------------------------------------

describe("DF-A4/D6 — classifier does not throw on edge cases", () => {
  it("Axis K-1: empty message does not throw and returns a valid structured error", () => {
    expect(() =>
      classifyCreateError(
        { kind: ProvisioningErrorKind.ACCESS_DENIED, message: "" },
        "AWS::S3::Bucket",
      ),
    ).not.toThrow();

    const result = classifyCreateError(
      { kind: ProvisioningErrorKind.ACCESS_DENIED, message: "" },
      "AWS::S3::Bucket",
    );

    expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.ACCESS_DENIED);
    expect(typeof result.userPrefix).toBe("string");
    expect(typeof result.shortMessage).toBe("string");
  });

  it("Axis K-2: undefined resourceType does not throw", () => {
    expect(() =>
      classifyCreateError(
        {
          kind: ProvisioningErrorKind.ACCESS_DENIED,
          message: "AccessDeniedException: some denial",
        },
        undefined,
      ),
    ).not.toThrow();
  });

  it("Axis K-3: ACCESS_DENIED with no permission-denied keywords still returns ACCESS_DENIED errorCode", () => {
    // Even if the message body doesn't contain known permission-denied
    // substrings, the errorCode must still be ACCESS_DENIED (not UNKNOWN)
    // because the ProvisioningErrorKind is authoritative.
    const result = classifyCreateError(
      {
        kind: ProvisioningErrorKind.ACCESS_DENIED,
        message: "An access denied error occurred.",
      },
      "AWS::Lambda::Function",
    );

    expect(result.errorCode).toBe(PROVISIONING_ERROR_CODES.ACCESS_DENIED);
  });
});
