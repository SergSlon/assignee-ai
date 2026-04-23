/**
 * Epic 98 W4.B2 — BP-SNS-004 MISLABELED closure (CRITICAL).
 *
 * Before W4.B2 the rule was `check_type: awareness` on
 * `AWS::SNS::Topic` / property_path `TopicPolicy` / expected_value
 * `true`. Because the awareness filter treats every awareness-tagged
 * check as always-fire, every SNS topic plan surfaced BP-SNS-004
 * regardless of whether the inline TopicPolicy actually granted
 * public access — the highest trust-eroding rule in the catalogue.
 *
 * After W4.B2:
 *   - New `wildcard-principal-no-condition` antipattern in
 *     `src/policy-inspector.ts`. Fires when an Allow statement has
 *     `Principal: "*"` (or `Principal: { AWS: "*" }`) AND no Condition
 *     clause. Condition-guarded wildcards (the canonical cross-
 *     account / cross-service trust shape) are NOT flagged.
 *   - BP-SNS-004 KEEPS `resource_type: AWS::SNS::Topic` and
 *     `property_path: TopicPolicy` — the inline TopicPolicy field IS
 *     the policy document (`{Version, Statement}` shape), which the
 *     inspector walks identically to a standalone `AWS::SNS::TopicPolicy`
 *     resource's `PolicyDocument`. Targeting the standalone type was
 *     rejected because `AWS::SNS::TopicPolicy` is not a first-class
 *     supported type yet (deferred to Epic 99 — see probe description).
 *   - `check_type: policy_antipattern`, `expected_value:
 *     wildcard-principal-no-condition`.
 *   - Severity CRITICAL unchanged (every remaining hit is genuine).
 *
 * Fixtures are real-shaped CloudFormation SNS TopicPolicy documents
 * with ARNs using the reserved-test account id `210987654321` per the
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
const BP_SNS_004_PATH = resolve(__dirname, "../sns/BP-SNS-004.yaml");
const TOPIC_ARN = "arn:aws:sns:us-east-1:210987654321:notifications";

function loadBpSns004(): BestPractice {
  const raw = readFileSync(BP_SNS_004_PATH, "utf-8");
  return parseYaml(raw) as BestPractice;
}

/**
 * Build an EvalContext for an SNS::Topic whose inline TopicPolicy
 * field carries the given policy document. The TopicPolicy field on
 * AWS::SNS::Topic has the same shape (`{Version, Statement}`) as a
 * standalone AWS::SNS::TopicPolicy resource's PolicyDocument — the
 * policy-inspector walks both identically.
 */
function ctx(policyDocument: Record<string, unknown>): EvalContext {
  return {
    resourceType: "AWS::SNS::Topic",
    desiredState: {
      TopicName: "notifications",
      TopicPolicy: policyDocument,
    },
  };
}

describe("BP-SNS-004 YAML manifest", () => {
  it("declares id BP-SNS-004", () => {
    const bp = loadBpSns004();
    expect(bp.id).toBe("BP-SNS-004");
  });

  it("targets AWS::SNS::Topic (first-class supported type, inline TopicPolicy surface)", () => {
    const bp = loadBpSns004();
    expect(bp.resource_type).toBe("AWS::SNS::Topic");
  });

  it("points property_path at the inline TopicPolicy field", () => {
    const bp = loadBpSns004();
    expect(bp.property_path).toBe("TopicPolicy");
  });

  it("declares `check_type: policy_antipattern` (no longer awareness)", () => {
    const bp = loadBpSns004();
    expect(bp.check_type).toBe("policy_antipattern");
  });

  it("uses the wildcard-principal-no-condition antipattern", () => {
    const bp = loadBpSns004();
    expect(bp.expected_value).toBe("wildcard-principal-no-condition");
  });

  it("keeps severity CRITICAL (false-positives are gone; every remaining hit is genuine)", () => {
    const bp = loadBpSns004();
    expect(bp.severity).toBe("CRITICAL");
    expect(bp.category).toBe("security");
  });
});

describe("BP-SNS-004 evaluateTriggers — legitimate topic policies MUST NOT fire", () => {
  const bp = loadBpSns004();
  const practices = [bp];

  it("does NOT fire on a narrow principal-list topic policy (no-fire baseline)", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowAppAccount",
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
    expect(findings.find((f) => f.practiceId === "BP-SNS-004")).toBeUndefined();
  });

  it("does NOT fire on wildcard-principal + aws:SourceAccount condition (cross-account trust shape)", () => {
    // Canonical cross-account trust: Principal: "*" is fine BECAUSE the
    // Condition narrows by aws:SourceAccount. W4.B2's whole point is to
    // stop flagging this shape.
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "CrossAccountPublish",
            Effect: "Allow",
            Principal: "*",
            Action: "sns:Publish",
            Resource: TOPIC_ARN,
            Condition: {
              StringEquals: { "aws:SourceAccount": "210987654321" },
            },
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-004")).toBeUndefined();
  });

  it("does NOT fire on wildcard-principal + aws:SourceArn condition (CloudFront/S3 trust shape)", () => {
    // CloudFront OAI / S3 bucket notification pattern — SNS topic
    // trusts a specific AWS resource via SourceArn.
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: "*",
            Action: "sns:Publish",
            Resource: TOPIC_ARN,
            Condition: {
              ArnEquals: {
                "aws:SourceArn": "arn:aws:s3:::appdata-210987654321-us-east-1",
              },
            },
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-004")).toBeUndefined();
  });

  it("does NOT fire on a service-principal policy (SNS via Lambda/EventBridge)", () => {
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
    expect(findings.find((f) => f.practiceId === "BP-SNS-004")).toBeUndefined();
  });

  it("does NOT fire when the statement is a Deny + wildcard Principal (legitimate deny sweep)", () => {
    // Deny + Principal: "*" is a legitimate deny sweep — the isAllow
    // guard in policy-inspector excludes Deny statements.
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Deny",
            Principal: "*",
            Action: "sns:Publish",
            Resource: TOPIC_ARN,
            Condition: { Bool: { "aws:SecureTransport": "false" } },
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-004")).toBeUndefined();
  });

  it("does NOT fire when the Topic has no inline TopicPolicy field (bare topic, no-fire baseline)", () => {
    // The plain-topic no-fire case: a Topic plan that emits no inline
    // TopicPolicy must not surface the rule. This is the canonical
    // regression the W4.B2 narrowing eliminates.
    const findings = evaluateTriggers(
      {
        resourceType: "AWS::SNS::Topic",
        desiredState: { TopicName: "notifications" },
      },
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-004")).toBeUndefined();
  });

  it("does NOT fire when the Topic has KMS encryption but no public TopicPolicy", () => {
    const findings = evaluateTriggers(
      {
        resourceType: "AWS::SNS::Topic",
        desiredState: {
          TopicName: "order-events",
          KmsMasterKeyId: "alias/aws/sns",
        },
      },
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-004")).toBeUndefined();
  });
});

describe("BP-SNS-004 evaluateTriggers — genuine public topic policies MUST fire CRITICAL", () => {
  const bp = loadBpSns004();
  const practices = [bp];

  it('DOES fire on Allow + `Principal: "*"` + no Condition (canonical public topic)', () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "OpenToTheWorld",
            Effect: "Allow",
            Principal: "*",
            Action: "sns:Subscribe",
            Resource: TOPIC_ARN,
          },
        ],
      }),
      practices,
    );
    const hit = findings.find((f) => f.practiceId === "BP-SNS-004");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("CRITICAL");
  });

  it('DOES fire on Allow + `Principal: { AWS: "*" }` + no Condition', () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: "*" },
            Action: "sns:Publish",
            Resource: TOPIC_ARN,
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-004")).toBeDefined();
  });

  it("DOES fire on Allow + wildcard Principal + empty Condition object ({})", () => {
    // An empty Condition is treated as "no condition" — a typo or
    // stub that effectively grants public access.
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: "*",
            Action: "sns:Subscribe",
            Resource: TOPIC_ARN,
            Condition: {},
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-004")).toBeDefined();
  });

  it("DOES fire when one of multiple statements is a no-condition wildcard (MIXED doc)", () => {
    // Guards against a policy that mixes a legitimate condition-guarded
    // wildcard with a bare wildcard — the bare one must be surfaced.
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "ConditionedOK",
            Effect: "Allow",
            Principal: "*",
            Action: "sns:Publish",
            Resource: TOPIC_ARN,
            Condition: {
              StringEquals: { "aws:SourceAccount": "210987654321" },
            },
          },
          {
            Sid: "BareWildcardLeaky",
            Effect: "Allow",
            Principal: "*",
            Action: "sns:Subscribe",
            Resource: TOPIC_ARN,
          },
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-004")).toBeDefined();
  });

  it("DOES fire on Statement-as-single-object form (CloudFormation legal shape)", () => {
    // CFN allows Statement to be a single object not wrapped in an
    // array — the policy-inspector normalises this, so the rule must
    // still fire.
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: {
          Effect: "Allow",
          Principal: "*",
          Action: "sns:Subscribe",
          Resource: TOPIC_ARN,
        },
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-004")).toBeDefined();
  });
});

describe("BP-SNS-004 evaluateTriggers — defensive input handling", () => {
  const bp = loadBpSns004();
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
    expect(findings.find((f) => f.practiceId === "BP-SNS-004")).toBeUndefined();
  });

  it("does NOT fire when Statement array contains non-object junk entries", () => {
    const findings = evaluateTriggers(
      ctx({
        Version: "2012-10-17",
        Statement: [
          "string-junk" as unknown as Record<string, unknown>,
          null as unknown as Record<string, unknown>,
          42 as unknown as Record<string, unknown>,
        ],
      }),
      practices,
    );
    expect(findings.find((f) => f.practiceId === "BP-SNS-004")).toBeUndefined();
  });
});
