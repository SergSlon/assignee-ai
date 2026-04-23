/**
 * Epic 98 W4.B3 — BP-SNS-003 HIGH MISLABELED closure.
 *
 * Before W4.B3 the rule was `check_type: awareness` on
 * `AWS::SNS::Topic`, property_path `TopicArn` — a field that always
 * exists on a Topic resource, so awareness-always-fires surfaced
 * the rule on every SNS topic plan. The rule's title mentioned
 * "restricting publish permissions" but the structural check had
 * no connection to publish permissions at all.
 *
 * After W4.B3:
 *   - `check_type: policy_antipattern`, `expected_value: wildcard-resource`
 *     targeting inline `TopicPolicy` — fires when an Allow statement
 *     in the topic policy has `Resource: "*"` (or `Resource: ["*"]`).
 *     A wildcard Resource silently broadens the statement's grant to
 *     every SNS topic in the account, not just the one the policy is
 *     attached to.
 *   - Distinct from BP-SNS-004 (`wildcard-principal-no-condition`) so
 *     the two rules cover orthogonal failure modes: BP-SNS-003 =
 *     resource-scope, BP-SNS-004 = principal-scope.
 *   - Mirrors the BP-S3-018 Tier-3 convention
 *     (`check_type: policy_antipattern` / `expected_value: wildcard-action`
 *     on `AWS::S3::BucketPolicy.PolicyDocument`). YAML-only migration —
 *     reuses the existing 10-antipattern catalogue without touching
 *     `policy-inspector.ts`.
 *   - Severity HIGH unchanged.
 *
 * Fixtures use real-shaped CloudFormation SNS topic policies with
 * ARNs keyed on the reserved-test account id `210987654321` per the
 * no-real-account-ids rule.
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
const BP_SNS_003_PATH = resolve(__dirname, "../sns/BP-SNS-003.yaml");
const TOPIC_ARN = "arn:aws:sns:us-east-1:210987654321:order-events";

function loadBpSns003(): BestPractice {
  const raw = readFileSync(BP_SNS_003_PATH, "utf-8");
  return parseYaml(raw) as BestPractice;
}

function ctx(policyDocument: Record<string, unknown>): EvalContext {
  return {
    resourceType: "AWS::SNS::Topic",
    desiredState: {
      TopicName: "order-events",
      TopicPolicy: policyDocument,
    },
  };
}

describe("BP-SNS-003 YAML manifest", () => {
  it("declares id BP-SNS-003", () => {
    const bp = loadBpSns003();
    expect(bp.id).toBe("BP-SNS-003");
  });

  it("targets AWS::SNS::Topic (unchanged, inline TopicPolicy field)", () => {
    const bp = loadBpSns003();
    expect(bp.resource_type).toBe("AWS::SNS::Topic");
  });

  it("points property_path at inline TopicPolicy (not the old TopicArn fake path)", () => {
    const bp = loadBpSns003();
    expect(bp.property_path).toBe("TopicPolicy");
  });

  it("declares `check_type: policy_antipattern` (no longer awareness)", () => {
    const bp = loadBpSns003();
    expect(bp.check_type).toBe("policy_antipattern");
  });

  it("uses the wildcard-resource antipattern (distinct from BP-SNS-004)", () => {
    const bp = loadBpSns003();
    expect(bp.expected_value).toBe("wildcard-resource");
  });

  it("keeps severity HIGH", () => {
    const bp = loadBpSns003();
    expect(bp.severity).toBe("HIGH");
    expect(bp.category).toBe("security");
  });
});

describe("BP-SNS-003 evaluateTriggers — properly scoped topic policies MUST NOT fire", () => {
  const bp = loadBpSns003();
  const practices = [bp];

  it("does NOT fire on a topic policy with specific Resource ARN (no-fire baseline)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowNarrowPublish",
            Effect: "Allow",
            Principal: {
              AWS: "arn:aws:iam::210987654321:role/app-publisher",
            },
            Action: "sns:Publish",
            Resource: TOPIC_ARN,
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-003")).toBeUndefined();
  });

  it("does NOT fire when Resource is an array of specific topic ARNs", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              AWS: "arn:aws:iam::210987654321:role/app-publisher",
            },
            Action: "sns:Publish",
            Resource: [
              TOPIC_ARN,
              "arn:aws:sns:us-east-1:210987654321:order-events-dlq",
            ],
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-003")).toBeUndefined();
  });

  it("does NOT fire when the Topic has no inline TopicPolicy field (bare topic)", () => {
    const findings = evaluateTriggers(
      {
        resourceType: "AWS::SNS::Topic",
        desiredState: { TopicName: "bare-topic" },
      },
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-003")).toBeUndefined();
  });

  it("does NOT fire on a Deny + wildcard Resource (legitimate deny sweep)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Deny",
            Principal: "*",
            Action: "sns:*",
            Resource: "*",
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-003")).toBeUndefined();
  });

  it("does NOT fire on a service-principal trust with specific Resource ARN", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "events.amazonaws.com" },
            Action: "sns:Publish",
            Resource: TOPIC_ARN,
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-003")).toBeUndefined();
  });

  it("does NOT fire on AWS::SNS::TopicPolicy resources (BP scoped to AWS::SNS::Topic inline policy)", () => {
    // BP-SNS-005/006 cover standalone TopicPolicy resource antipatterns.
    // BP-SNS-003 is scoped to the inline TopicPolicy field on Topic so
    // the two rule families don't double-fire on the same policy doc.
    const findings = evaluateTriggers(
      {
        resourceType: "AWS::SNS::TopicPolicy",
        desiredState: {
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: {
                  AWS: "arn:aws:iam::210987654321:role/some-role",
                },
                Action: "sns:Publish",
                Resource: "*",
              },
            ],
          },
        },
      },
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-003")).toBeUndefined();
  });
});

describe("BP-SNS-003 evaluateTriggers — wildcard-Resource grants MUST fire HIGH", () => {
  const bp = loadBpSns003();
  const practices = [bp];

  it('DOES fire on Allow + `Resource: "*"` (canonical over-scoped grant)', () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowAppPublishEverywhere",
            Effect: "Allow",
            Principal: {
              AWS: "arn:aws:iam::210987654321:role/app-publisher",
            },
            Action: "sns:Publish",
            Resource: "*",
          },
        ],
      }),
      practices,
    );
    const hit = findings.find((f) => f.practiceId === "BP-SNS-003");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("HIGH");
  });

  it('DOES fire on Allow + `Resource: ["*"]` (array form of wildcard)', () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              AWS: "arn:aws:iam::210987654321:role/ops-role",
            },
            Action: "sns:*",
            Resource: ["*"],
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-003")).toBeDefined();
  });

  it("DOES fire when a Resource array contains wildcard alongside specific ARNs (mixed)", () => {
    // Even one `*` in the array broadens the scope — BP-SNS-003 must
    // catch this before a well-intentioned author assumes the specific
    // ARNs narrow the grant.
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              AWS: "arn:aws:iam::210987654321:role/app-publisher",
            },
            Action: "sns:Publish",
            Resource: [TOPIC_ARN, "*"],
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-003")).toBeDefined();
  });

  it("DOES fire on a mixed doc where one statement is narrow and another is wildcard (first-offending)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "NarrowPublish",
            Effect: "Allow",
            Principal: {
              AWS: "arn:aws:iam::210987654321:role/app-publisher",
            },
            Action: "sns:Publish",
            Resource: TOPIC_ARN,
          },
          {
            Sid: "OverScopedOps",
            Effect: "Allow",
            Principal: {
              AWS: "arn:aws:iam::210987654321:role/ops-role",
            },
            Action: "sns:*",
            Resource: "*",
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-003")).toBeDefined();
  });

  it("DOES fire on Statement-as-single-object form (CloudFormation legal shape)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: {
          Effect: "Allow",
          Principal: {
            AWS: "arn:aws:iam::210987654321:role/app-publisher",
          },
          Action: "sns:Publish",
          Resource: "*",
        },
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-003")).toBeDefined();
  });
});

describe("BP-SNS-003 evaluateTriggers — defensive handling", () => {
  const bp = loadBpSns003();
  const practices = [bp];

  it("does NOT fire on a malformed inline TopicPolicy (string where object expected)", () => {
    const findings = evaluateTriggers(
      {
        resourceType: "AWS::SNS::Topic",
        desiredState: {
          TopicName: "weird",
          TopicPolicy: "not-an-object",
        },
      },
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-003")).toBeUndefined();
  });

  it("does NOT fire when Statement contains non-object junk entries", () => {
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
    expect(findings.find((f) => f.practiceId === "BP-SNS-003")).toBeUndefined();
  });
});
