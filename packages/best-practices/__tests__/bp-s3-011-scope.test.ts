/**
 * Epic 98 W4.B4 — BP-S3-011 HIGH MISLABELED closure.
 *
 * Before W4.B4 the rule was `check_type: awareness` on `AWS::S3::Bucket`
 * with `property_path: BucketPolicy.Statement` and `expected_value: true`.
 * Because the awareness filter treats every awareness-tagged check as
 * always-fire, every S3 bucket plan surfaced BP-S3-011 regardless of
 * whether the bucket policy actually enforced SSL-only access.
 *
 * After W4.B4:
 *   - New `missing-secure-transport-deny` antipattern in
 *     `src/policy-inspector.ts`. Uses ABSENCE semantics: matches (rule
 *     fires) when the BucketPolicy document does NOT contain a Deny
 *     statement that blocks non-SSL requests via
 *     `Condition.Bool["aws:SecureTransport"] == "false"` (tolerates the
 *     string `"false"`, the boolean `false`, and the array-of-values
 *     form `["false"]` per real CloudFormation emissions).
 *   - BP-S3-011 migrates to `resource_type: AWS::S3::BucketPolicy`,
 *     `property_path: PolicyDocument`, `check_type: policy_antipattern`,
 *     `expected_value: missing-secure-transport-deny` — matching the
 *     BP-S3-018/019/020 resource-level convention.
 *   - `triggers.excludePatterns: ["static-website"]` preserved so the
 *     pattern's intentional public-read semantics don't force SSL.
 *   - Severity HIGH unchanged.
 *
 * Absence semantics nuance: unlike presence antipatterns (BP-SNS-004
 * etc.), a MISSING BucketPolicy resource does fire the rule — the
 * required Deny clearly can't exist if there's no policy at all. The
 * rule-runner routes undefined `fieldValue` to the inspector's
 * absence branch rather than the default "pass on missing" short-
 * circuit. See `isAbsenceAntipattern` in `src/policy-inspector.ts`.
 *
 * Fixtures use real-shaped CloudFormation BucketPolicy documents with
 * ARNs keyed on the reserved-test account id `210987654321` per the
 * no-real-account-ids-in-repo rule.
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
const BP_S3_011_PATH = resolve(__dirname, "../s3/BP-S3-011.yaml");
const BUCKET_ARN = "arn:aws:s3:::appdata-210987654321-us-east-1";

function loadBpS3011(): BestPractice {
  const raw = readFileSync(BP_S3_011_PATH, "utf-8");
  return parseYaml(raw) as BestPractice;
}

function ctx(policyDocument: Record<string, unknown>): EvalContext {
  return {
    resourceType: "AWS::S3::BucketPolicy",
    desiredState: { PolicyDocument: policyDocument },
  };
}

describe("BP-S3-011 YAML manifest", () => {
  it("declares id BP-S3-011", () => {
    const bp = loadBpS3011();
    expect(bp.id).toBe("BP-S3-011");
  });

  it("targets AWS::S3::BucketPolicy (migrated off AWS::S3::Bucket)", () => {
    const bp = loadBpS3011();
    expect(bp.resource_type).toBe("AWS::S3::BucketPolicy");
  });

  it("points property_path at PolicyDocument (matches BP-S3-018/019/020 convention)", () => {
    const bp = loadBpS3011();
    expect(bp.property_path).toBe("PolicyDocument");
  });

  it("declares `check_type: policy_antipattern` (no longer awareness)", () => {
    const bp = loadBpS3011();
    expect(bp.check_type).toBe("policy_antipattern");
  });

  it("uses the missing-secure-transport-deny absence antipattern", () => {
    const bp = loadBpS3011();
    expect(bp.expected_value).toBe("missing-secure-transport-deny");
  });

  it("preserves the static-website excludePatterns trigger", () => {
    const bp = loadBpS3011();
    expect(bp.triggers).toBeDefined();
    expect(bp.triggers?.length).toBeGreaterThanOrEqual(1);
    expect(bp.triggers?.[0]?.excludePatterns).toEqual(["static-website"]);
  });

  it("keeps severity HIGH", () => {
    const bp = loadBpS3011();
    expect(bp.severity).toBe("HIGH");
    expect(bp.category).toBe("security");
  });
});

describe("BP-S3-011 evaluateTriggers — policies that enforce SSL MUST NOT fire", () => {
  const bp = loadBpS3011();
  const practices = [bp];

  it("does NOT fire on a BucketPolicy with the canonical Deny-non-SSL clause (no-fire baseline)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "DenyNonSSL",
            Effect: "Deny",
            Principal: "*",
            Action: "s3:*",
            Resource: [BUCKET_ARN, `${BUCKET_ARN}/*`],
            Condition: {
              Bool: { "aws:SecureTransport": "false" },
            },
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-S3-011")).toBeUndefined();
  });

  it("does NOT fire when an Allow is paired with the canonical Deny (real-shape bucket policy)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowNarrowRead",
            Effect: "Allow",
            Principal: {
              AWS: "arn:aws:iam::210987654321:role/app-reader",
            },
            Action: "s3:GetObject",
            Resource: `${BUCKET_ARN}/*`,
          },
          {
            Sid: "DenyNonSSL",
            Effect: "Deny",
            Principal: "*",
            Action: "s3:*",
            Resource: [BUCKET_ARN, `${BUCKET_ARN}/*`],
            Condition: {
              Bool: { "aws:SecureTransport": "false" },
            },
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-S3-011")).toBeUndefined();
  });

  it("does NOT fire when the Condition uses the boolean false literal (CFN alt form)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Deny",
            Principal: "*",
            Action: "s3:*",
            Resource: [BUCKET_ARN, `${BUCKET_ARN}/*`],
            Condition: {
              Bool: { "aws:SecureTransport": false },
            },
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-S3-011")).toBeUndefined();
  });

  it("does NOT fire when Action is broader than s3:* (e.g. '*' wildcard covers all S3 actions)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Deny",
            Principal: "*",
            Action: "*",
            Resource: [BUCKET_ARN, `${BUCKET_ARN}/*`],
            Condition: {
              Bool: { "aws:SecureTransport": "false" },
            },
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-S3-011")).toBeUndefined();
  });
});

describe("BP-S3-011 evaluateTriggers — missing SSL enforcement MUST fire HIGH", () => {
  const bp = loadBpS3011();
  const practices = [bp];

  it("DOES fire when the BucketPolicy has only an Allow (no Deny at all)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowPublicRead",
            Effect: "Allow",
            Principal: "*",
            Action: "s3:GetObject",
            Resource: `${BUCKET_ARN}/*`,
          },
        ],
      }),
      practices,
    );
    const hit = findings.find((f) => f.practiceId === "BP-S3-011");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("HIGH");
  });

  it("DOES fire when a Deny uses the wrong Condition (e.g. aws:SourceVpc instead of aws:SecureTransport)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Deny",
            Principal: "*",
            Action: "s3:*",
            Resource: [BUCKET_ARN, `${BUCKET_ARN}/*`],
            Condition: {
              StringEquals: { "aws:SourceVpc": "vpc-12345" },
            },
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-S3-011")).toBeDefined();
  });

  it("DOES fire when the Deny targets a narrow Principal (leaves other callers unprotected)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Deny",
            Principal: {
              AWS: "arn:aws:iam::210987654321:role/some-role",
            },
            Action: "s3:*",
            Resource: [BUCKET_ARN, `${BUCKET_ARN}/*`],
            Condition: {
              Bool: { "aws:SecureTransport": "false" },
            },
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-S3-011")).toBeDefined();
  });

  it("DOES fire when the Statement array is empty (malformed-but-present policy)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-S3-011")).toBeDefined();
  });

  it("DOES fire on a completely missing BucketPolicy (absence = failure for this rule)", () => {
    // Absence semantics: the BucketPolicy resource exists in the plan
    // (so the rule applies) but the PolicyDocument is missing. The
    // required Deny-non-SSL clearly can't exist → rule fires.
    // Routed through the rule-runner's absence-aware branch.
    const findings = evaluateTriggers(
      {
        resourceType: "AWS::S3::BucketPolicy",
        desiredState: { Bucket: "appdata-210987654321-us-east-1" },
      },
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-S3-011")).toBeDefined();
  });
});

describe("BP-S3-011 evaluateTriggers — static-website exclusion preserved", () => {
  const bp = loadBpS3011();
  const practices = [bp];

  it("does NOT fire on a patternId `static-website` plan (intentional public-read exclusion)", () => {
    // Static-website hosting intentionally serves public content;
    // forcing SSL-only conflicts with the pattern's purpose. The
    // excludePatterns trigger must suppress the rule even though
    // the policy has no Deny-non-SSL clause.
    const findings = evaluateTriggers(
      {
        resourceType: "AWS::S3::BucketPolicy",
        desiredState: {
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: "*",
                Action: "s3:GetObject",
                Resource: `${BUCKET_ARN}/*`,
              },
            ],
          },
        },
        patternId: "static-website",
      },
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-S3-011")).toBeUndefined();
  });

  it("DOES fire on a non-static-website plan with the same missing-SSL shape (baseline)", () => {
    // Control: the same policy doc WITHOUT the static-website patternId
    // must fire the rule — confirms the exclusion is the suppressing
    // factor, not some accidental silent pass.
    const findings = evaluateTriggers(
      {
        resourceType: "AWS::S3::BucketPolicy",
        desiredState: {
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: "*",
                Action: "s3:GetObject",
                Resource: `${BUCKET_ARN}/*`,
              },
            ],
          },
        },
      },
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-S3-011")).toBeDefined();
  });
});

describe("BP-S3-011 evaluateTriggers — defensive input handling", () => {
  const bp = loadBpS3011();
  const practices = [bp];

  it("does NOT crash on a malformed PolicyDocument (string where object expected)", () => {
    const findings = evaluateTriggers(
      {
        resourceType: "AWS::S3::BucketPolicy",
        desiredState: { PolicyDocument: "not-an-object" },
      },
      practices,
    );
    // Malformed doc → extracted as null statements → absence-check
    // fires. A malformed policy is still a missing Deny-non-SSL.
    expect(findings.find((f) => f.practiceId === "BP-S3-011")).toBeDefined();
  });
});
