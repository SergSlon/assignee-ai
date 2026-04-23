/**
 * Epic 98 W4.B5 — BP-IAM-010 HIGH MISLABELED closure.
 *
 * Before W4.B5 the rule was `check_type: awareness` on
 * `AWS::IAM::Role` with `property_path: AssumeRolePolicyDocument` and
 * `expected_value: true`. Awareness always fires → every IAM role
 * plan surfaced BP-IAM-010 regardless of whether the trust policy
 * actually granted cross-account access, training users to ignore
 * HIGH severity.
 *
 * After W4.B5:
 *   - New `cross-account-no-external-id` antipattern in
 *     `src/policy-inspector.ts`. Fires on an Allow statement that
 *     grants `sts:AssumeRole` to a non-wildcard AWS-ARN Principal
 *     without an `sts:ExternalId` narrow (StringEquals / StringLike /
 *     StringEqualsIgnoreCase). Service principals (lambda, ec2,
 *     events, etc.) and Federated (OIDC) principals are NOT flagged.
 *     Wildcard Principals are deferred to sibling wildcard-* checks.
 *   - BP-IAM-010 migrates to `check_type: policy_antipattern`,
 *     `expected_value: cross-account-no-external-id`. Severity HIGH
 *     unchanged. resource_type + property_path unchanged.
 *
 * Fixtures use real-shaped CloudFormation AssumeRolePolicyDocument
 * values with ARNs keyed on the reserved-test account id
 * `210987654321` per the no-real-account-ids rule.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { evaluateTriggers } from "../src/evaluate.js";
import type { EvalContext } from "../src/evaluate.js";
import type { BestPractice } from "../src/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BP_IAM_010_PATH = resolve(__dirname, "../iam/BP-IAM-010.yaml");

const TRUSTED_ACCOUNT_ROOT = "arn:aws:iam::210987654321:root";
const TRUSTED_ROLE = "arn:aws:iam::210987654321:role/partner-delivery";
const EXTERNAL_ID = "32-char-shared-secret-1234567890ab";

function loadBpIam010(): BestPractice {
  const raw = readFileSync(BP_IAM_010_PATH, "utf-8");
  return parseYaml(raw) as BestPractice;
}

function ctx(trustDocument: Record<string, unknown>): EvalContext {
  return {
    resourceType: "AWS::IAM::Role",
    desiredState: {
      RoleName: "assignee-test-role",
      AssumeRolePolicyDocument: trustDocument,
    },
  };
}

describe("BP-IAM-010 YAML manifest", () => {
  it("declares id BP-IAM-010", () => {
    const bp = loadBpIam010();
    expect(bp.id).toBe("BP-IAM-010");
  });

  it("targets AWS::IAM::Role (unchanged)", () => {
    const bp = loadBpIam010();
    expect(bp.resource_type).toBe("AWS::IAM::Role");
  });

  it("points property_path at AssumeRolePolicyDocument (unchanged)", () => {
    const bp = loadBpIam010();
    expect(bp.property_path).toBe("AssumeRolePolicyDocument");
  });

  it("declares `check_type: policy_antipattern` (no longer awareness)", () => {
    const bp = loadBpIam010();
    expect(bp.check_type).toBe("policy_antipattern");
  });

  it("uses the cross-account-no-external-id antipattern", () => {
    const bp = loadBpIam010();
    expect(bp.expected_value).toBe("cross-account-no-external-id");
  });

  it("keeps severity HIGH", () => {
    const bp = loadBpIam010();
    expect(bp.severity).toBe("HIGH");
    expect(bp.category).toBe("security");
  });
});

describe("BP-IAM-010 evaluateTriggers — protected or out-of-scope trust policies MUST NOT fire", () => {
  const bp = loadBpIam010();
  const practices = [bp];

  it("does NOT fire on a Lambda service-principal trust (out-of-scope, no-fire baseline)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-IAM-010")).toBeUndefined();
  });

  it("does NOT fire on an EC2 instance-profile trust (service principal)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-IAM-010")).toBeUndefined();
  });

  it("does NOT fire on a cross-account trust with StringEquals sts:ExternalId", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "TrustPartner",
            Effect: "Allow",
            Principal: { AWS: TRUSTED_ACCOUNT_ROOT },
            Action: "sts:AssumeRole",
            Condition: {
              StringEquals: { "sts:ExternalId": EXTERNAL_ID },
            },
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-IAM-010")).toBeUndefined();
  });

  it("does NOT fire on a cross-account role trust with StringLike sts:ExternalId (prefix pattern)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: TRUSTED_ROLE },
            Action: "sts:AssumeRole",
            Condition: {
              StringLike: { "sts:ExternalId": "tenant-*" },
            },
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-IAM-010")).toBeUndefined();
  });

  it("does NOT fire on a Federated (OIDC) trust (different attack surface)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              Federated: "arn:aws:iam::210987654321:oidc-provider/example.com",
            },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: { "example.com:aud": "my-audience" },
            },
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-IAM-010")).toBeUndefined();
  });

  it("does NOT fire on a wildcard Principal trust (flagged by sibling wildcard-* checks)", () => {
    // This shape is genuinely bad, but BP-IAM-010 defers to the
    // wildcard-principal / wildcard-principal-no-condition rules.
    // Avoiding double-firing.
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: "*",
            Action: "sts:AssumeRole",
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-IAM-010")).toBeUndefined();
  });

  it("does NOT fire when the Action is not sts:AssumeRole (e.g. s3:GetObject on a misapplied trust)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: TRUSTED_ROLE },
            Action: "s3:GetObject",
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-IAM-010")).toBeUndefined();
  });

  it("does NOT fire on a Deny statement + cross-account ARN (legitimate deny sweep)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Deny",
            Principal: { AWS: TRUSTED_ROLE },
            Action: "sts:AssumeRole",
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-IAM-010")).toBeUndefined();
  });
});

describe("BP-IAM-010 evaluateTriggers — cross-account ARN trusts without ExternalId MUST fire HIGH", () => {
  const bp = loadBpIam010();
  const practices = [bp];

  it("DOES fire on `:root` cross-account trust with no Condition", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "TrustPartner",
            Effect: "Allow",
            Principal: { AWS: TRUSTED_ACCOUNT_ROOT },
            Action: "sts:AssumeRole",
          },
        ],
      }),
      practices,
    );
    const hit = findings.find((f) => f.practiceId === "BP-IAM-010");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("HIGH");
  });

  it("DOES fire on a cross-account role-ARN trust with no Condition", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: TRUSTED_ROLE },
            Action: "sts:AssumeRole",
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-IAM-010")).toBeDefined();
  });

  it("DOES fire when a Condition is present but does not narrow by sts:ExternalId (aws:SourceVpc only)", () => {
    // Operators sometimes think aws:SourceVpc / aws:SourceIp is
    // enough — for confused-deputy protection, sts:ExternalId is
    // specifically required. Network narrowing doesn't substitute.
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: TRUSTED_ROLE },
            Action: "sts:AssumeRole",
            Condition: {
              StringEquals: { "aws:SourceVpc": "vpc-12345" },
            },
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-IAM-010")).toBeDefined();
  });

  it("DOES fire when sts:ExternalId is present but empty-string (stub / author mistake)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: TRUSTED_ROLE },
            Action: "sts:AssumeRole",
            Condition: {
              StringEquals: { "sts:ExternalId": "" },
            },
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-IAM-010")).toBeDefined();
  });

  it("DOES fire when Principal.AWS is an array of ARNs and none is conditioned", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: [TRUSTED_ROLE, TRUSTED_ACCOUNT_ROOT] },
            Action: "sts:AssumeRole",
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-IAM-010")).toBeDefined();
  });

  it("DOES fire on a GovCloud-partition cross-account trust (arn:aws-us-gov:...)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: "arn:aws-us-gov:iam::210987654321:root" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-IAM-010")).toBeDefined();
  });

  it("DOES fire on a mixed doc where one statement is ExternalId-guarded and another is bare", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "OKTrust",
            Effect: "Allow",
            Principal: { AWS: TRUSTED_ROLE },
            Action: "sts:AssumeRole",
            Condition: {
              StringEquals: { "sts:ExternalId": EXTERNAL_ID },
            },
          },
          {
            Sid: "LeakyBareTrust",
            Effect: "Allow",
            Principal: { AWS: TRUSTED_ACCOUNT_ROOT },
            Action: "sts:AssumeRole",
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-IAM-010")).toBeDefined();
  });

  it("DOES fire when Action is `*` (wildcard covers sts:AssumeRole) + IAM ARN + no Condition", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: TRUSTED_ROLE },
            Action: "*",
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-IAM-010")).toBeDefined();
  });
});

describe("BP-IAM-010 evaluateTriggers — defensive handling", () => {
  const bp = loadBpIam010();
  const practices = [bp];

  it("does NOT fire when the role has no AssumeRolePolicyDocument at all (missing fieldValue)", () => {
    // Absence is not the failure mode for this rule — it's a
    // presence antipattern. Missing trust doc means no cross-
    // account attack surface to guard.
    const findings = evaluateTriggers(
      {
        resourceType: "AWS::IAM::Role",
        desiredState: { RoleName: "bare-role" },
      },
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-IAM-010")).toBeUndefined();
  });

  it("does NOT fire on a malformed trust document (string where object expected)", () => {
    const findings = evaluateTriggers(
      {
        resourceType: "AWS::IAM::Role",
        desiredState: {
          RoleName: "weird",
          AssumeRolePolicyDocument: "not-an-object",
        },
      },
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-IAM-010")).toBeUndefined();
  });

  it("does NOT fire when Statement array contains non-object junk entries", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          "garbage" as unknown as Record<string, unknown>,
          42 as unknown as Record<string, unknown>,
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-IAM-010")).toBeUndefined();
  });
});
