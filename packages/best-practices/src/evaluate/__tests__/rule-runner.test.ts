import { describe, it, expect } from "vitest";
import { checkPasses } from "../rule-runner.js";
import type { PolicyContext } from "../policy-context.js";

/**
 * Unit tests for `checkPasses` in rule-runner.ts.
 *
 * Epic 99 Wave 2 W-004 (HIGH): the default branch previously returned
 * `true` (silent pass) for any unrecognised check_type. This masked YAML
 * typos — the rule would appear to evaluate but always pass, hiding the
 * misconfiguration from authors and consumers. The fix throws an Error so
 * unknown check_types surface immediately at evaluation time.
 *
 * Tests here cover:
 *   1. The throw on unknown check_type (primary W-004 regression guard).
 *   2. Basic happy-path coverage for each known check_type so we can
 *      detect if a future refactor accidentally breaks dispatch.
 */
describe("checkPasses — default branch throws on unknown check_type", () => {
  it("throws for a completely unknown check_type string", () => {
    expect(() => checkPasses("equls", "value", "value")).toThrowError(
      /Unknown check_type "equls"/,
    );
  });

  it("includes valid check_types in the error message", () => {
    expect(() => checkPasses("typo_type", undefined, undefined)).toThrowError(
      /Valid check_types:/,
    );
  });

  it("includes rule-runner.ts in the error message for YAML author guidance", () => {
    expect(() => checkPasses("bogus", "x", "y")).toThrowError(
      /rule-runner\.ts/,
    );
  });

  it("throws for an empty string check_type (not a valid case)", () => {
    expect(() => checkPasses("", undefined, undefined)).toThrowError(
      /Unknown check_type ""/,
    );
  });

  it("throws for a check_type that is close but not exact (case-sensitive)", () => {
    // "Equals" with capital E is NOT the same as "equals"
    expect(() => checkPasses("Equals", "a", "a")).toThrowError(
      /Unknown check_type "Equals"/,
    );
  });
});

describe("checkPasses — awareness-family checks always fail (regression guard)", () => {
  // Epic 98 W5.P1: awareness rules fire on EVERY plan of the matched resource
  // type regardless of whether the fieldValue is present. These tests guard
  // against future refactors that might accidentally introduce a fieldValue
  // guard before checkPasses(), which would silently suppress informational
  // findings when the plan doesn't include the target field at plan-time.
  it("awareness — fails (fires) when fieldValue is undefined (runtime-only field absent at plan-time)", () => {
    expect(checkPasses("awareness", undefined, true)).toBe(false);
  });

  it("awareness — fails (fires) when fieldValue is null", () => {
    expect(checkPasses("awareness", null, true)).toBe(false);
  });

  it("awareness — fails (fires) when fieldValue is a value", () => {
    expect(checkPasses("awareness", "i-1234567890abcdef0", true)).toBe(false);
  });

  it("cross_resource_count — fails (fires) when fieldValue is undefined", () => {
    expect(checkPasses("cross_resource_count", undefined, true)).toBe(false);
  });

  it("cross_resource_reference — fails (fires) when fieldValue is undefined", () => {
    expect(checkPasses("cross_resource_reference", undefined, true)).toBe(
      false,
    );
  });
});

describe("checkPasses — known check_types dispatch correctly (regression guard)", () => {
  it("equals — passes when values match", () => {
    expect(checkPasses("equals", "foo", "foo")).toBe(true);
  });

  it("equals — fails when values differ", () => {
    expect(checkPasses("equals", "foo", "bar")).toBe(false);
  });

  it("not_equals — passes when values differ", () => {
    expect(checkPasses("not_equals", "foo", "bar")).toBe(true);
  });

  it("not_equals — fails when values match", () => {
    expect(checkPasses("not_equals", "foo", "foo")).toBe(false);
  });

  it("exists — passes for a non-empty string", () => {
    expect(checkPasses("exists", "present", undefined)).toBe(true);
  });

  it("exists — fails for undefined", () => {
    expect(checkPasses("exists", undefined, undefined)).toBe(false);
  });

  it("exists — fails for empty array", () => {
    expect(checkPasses("exists", [], undefined)).toBe(false);
  });

  it("not_exists — passes for undefined", () => {
    expect(checkPasses("not_exists", undefined, undefined)).toBe(true);
  });

  it("not_exists — fails for a non-empty value", () => {
    expect(checkPasses("not_exists", "present", undefined)).toBe(false);
  });

  it("greater_than — passes when field > expected", () => {
    expect(checkPasses("greater_than", 10, 5)).toBe(true);
  });

  it("greater_than — fails when field <= expected", () => {
    expect(checkPasses("greater_than", 5, 10)).toBe(false);
  });

  it("less_than — passes when field < expected", () => {
    expect(checkPasses("less_than", 3, 10)).toBe(true);
  });

  it("less_than — fails when field >= expected", () => {
    expect(checkPasses("less_than", 10, 3)).toBe(false);
  });

  it("contains — passes when string includes substring", () => {
    expect(checkPasses("contains", "foobar", "foo")).toBe(true);
  });

  it("contains — fails when string does not include substring", () => {
    expect(checkPasses("contains", "foobar", "xyz")).toBe(false);
  });

  it("not_contains — passes when string does not include substring", () => {
    expect(checkPasses("not_contains", "foobar", "xyz")).toBe(true);
  });

  it("not_contains — fails when string includes substring", () => {
    expect(checkPasses("not_contains", "foobar", "foo")).toBe(false);
  });

  it("not_contains_pattern — passes when no element matches regex", () => {
    expect(
      checkPasses(
        "not_contains_pattern",
        ["ReadOnlyAccess", "ReadAccess"],
        "FullAccess",
      ),
    ).toBe(true);
  });

  it("not_contains_pattern — fails when an element matches regex", () => {
    expect(
      checkPasses(
        "not_contains_pattern",
        ["AdministratorAccess", "FullAccess"],
        "FullAccess",
      ),
    ).toBe(false);
  });

  it("conditional_forbidden — passes when field is undefined", () => {
    expect(checkPasses("conditional_forbidden", undefined, undefined)).toBe(
      true,
    );
  });

  it("conditional_forbidden — fails when field is present", () => {
    expect(checkPasses("conditional_forbidden", "present", undefined)).toBe(
      false,
    );
  });

  it("sg_high_risk_public_exposure — passes when ingress array is empty", () => {
    expect(
      checkPasses("sg_high_risk_public_exposure", [], "0.0.0.0/0:22,3389"),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Epic 99 W3e — PolicyContext plumbing in checkPasses                */
/* ------------------------------------------------------------------ */

describe("checkPasses — policy_antipattern with PolicyContext (Epic 99 W3e)", () => {
  // A minimal cross-account trust policy document — no ExternalId condition.
  // Would normally fire cross-account-no-external-id in trust context.
  const BARE_TRUST_DOC = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: "arn:aws:iam::210987654321:root" },
        Action: "sts:AssumeRole",
      },
    ],
  };

  it("W3e: policy_antipattern cross-account-no-external-id FAILS (finding fires) with no context", () => {
    // Backward-compatible: no context → trust semantics → finding fires.
    expect(
      checkPasses(
        "policy_antipattern",
        BARE_TRUST_DOC,
        "cross-account-no-external-id",
      ),
    ).toBe(false);
  });

  it("W3e: policy_antipattern cross-account-no-external-id FAILS (finding fires) with trust context", () => {
    const ctx: PolicyContext = { kind: "trust" };
    expect(
      checkPasses(
        "policy_antipattern",
        BARE_TRUST_DOC,
        "cross-account-no-external-id",
        ctx,
      ),
    ).toBe(false);
  });

  it("W3e: policy_antipattern cross-account-no-external-id PASSES (no finding) with resource context", () => {
    // A resource policy that happens to have sts:AssumeRole — should NOT trigger
    // the confused-deputy check. The context gate must suppress the finding.
    const ctx: PolicyContext = { kind: "resource" };
    expect(
      checkPasses(
        "policy_antipattern",
        BARE_TRUST_DOC,
        "cross-account-no-external-id",
        ctx,
      ),
    ).toBe(true);
  });

  it("W3e: policy_antipattern cross-account-no-external-id PASSES (no finding) with identity context", () => {
    const ctx: PolicyContext = { kind: "identity" };
    expect(
      checkPasses(
        "policy_antipattern",
        BARE_TRUST_DOC,
        "cross-account-no-external-id",
        ctx,
      ),
    ).toBe(true);
  });

  // wildcard-principal-no-condition — W-019 fix: trivially-permissive conditions now fire.
  const WILDCARD_TRIVIAL_CONDITION_DOC = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: "*",
        Action: "sns:Publish",
        Resource: "arn:aws:sns:us-east-1:210987654321:notifications",
        Condition: {
          // The CT-7 loophole: meaningful key but wildcard value → no real scoping.
          StringLike: { "aws:SourceAccount": "*" },
        },
      },
    ],
  };

  it("W-019: policy_antipattern wildcard-principal-no-condition FAILS on trivially-permissive Condition (wildcard key value)", () => {
    // The finding must fire — the condition disarms nothing.
    expect(
      checkPasses(
        "policy_antipattern",
        WILDCARD_TRIVIAL_CONDITION_DOC,
        "wildcard-principal-no-condition",
      ),
    ).toBe(false);
  });

  const PROPERLY_SCOPED_DOC = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: "*",
        Action: "sns:Publish",
        Resource: "arn:aws:sns:us-east-1:210987654321:notifications",
        Condition: {
          StringEquals: { "aws:SourceAccount": "210987654321" },
        },
      },
    ],
  };

  it("W-019: policy_antipattern wildcard-principal-no-condition PASSES on properly-scoped Condition (specific account)", () => {
    // The finding must NOT fire — the condition provides real scoping.
    expect(
      checkPasses(
        "policy_antipattern",
        PROPERLY_SCOPED_DOC,
        "wildcard-principal-no-condition",
      ),
    ).toBe(true);
  });
});
