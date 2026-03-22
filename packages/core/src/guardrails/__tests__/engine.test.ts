/**
 * Unit tests for GuardrailEngine — registry, evaluation, and performance.
 *
 * @see Story 10.4, Task 7.2, 7.3
 */

import { describe, it, expect } from "vitest";
import { GuardrailEngine } from "../engine.js";
import { defaultGuardrailEngine } from "../index.js";
import type { GuardrailRule } from "../types.js";

describe("GuardrailEngine", () => {
  it("evaluates only rules matching the given resource type", () => {
    const engine = new GuardrailEngine();
    const s3Rule: GuardrailRule = {
      ruleId: "test-s3",
      resourceTypes: ["AWS::S3::Bucket"],
      evaluate: () => ({
        ruleId: "test-s3",
        severity: "warning",
        message: "S3 issue",
      }),
    };
    const iamRule: GuardrailRule = {
      ruleId: "test-iam",
      resourceTypes: ["AWS::IAM::Role"],
      evaluate: () => ({
        ruleId: "test-iam",
        severity: "critical",
        message: "IAM issue",
      }),
    };

    engine.register(s3Rule);
    engine.register(iamRule);

    const s3Findings = engine.evaluate("AWS::S3::Bucket", {});
    expect(s3Findings).toHaveLength(1);
    expect(s3Findings[0]!.ruleId).toBe("test-s3");

    const iamFindings = engine.evaluate("AWS::IAM::Role", {});
    expect(iamFindings).toHaveLength(1);
    expect(iamFindings[0]!.ruleId).toBe("test-iam");
  });

  it("returns empty array for clean configs (no matching rules trigger)", () => {
    const engine = new GuardrailEngine();
    const passingRule: GuardrailRule = {
      ruleId: "always-pass",
      resourceTypes: ["AWS::S3::Bucket"],
      evaluate: () => null,
    };

    engine.register(passingRule);

    const findings = engine.evaluate("AWS::S3::Bucket", {});
    expect(findings).toHaveLength(0);
  });

  it("returns empty array for unregistered resource types", () => {
    const engine = new GuardrailEngine();
    const findings = engine.evaluate("AWS::SNS::Topic", {});
    expect(findings).toHaveLength(0);
  });

  it("returns multiple findings for multiple violations", () => {
    const engine = new GuardrailEngine();
    const rule1: GuardrailRule = {
      ruleId: "rule-1",
      resourceTypes: ["AWS::S3::Bucket"],
      evaluate: () => ({
        ruleId: "rule-1",
        severity: "critical",
        message: "Issue 1",
      }),
    };
    const rule2: GuardrailRule = {
      ruleId: "rule-2",
      resourceTypes: ["AWS::S3::Bucket"],
      evaluate: () => ({
        ruleId: "rule-2",
        severity: "warning",
        message: "Issue 2",
      }),
    };

    engine.register(rule1);
    engine.register(rule2);

    const findings = engine.evaluate("AWS::S3::Bucket", {});
    expect(findings).toHaveLength(2);
  });
});

describe("defaultGuardrailEngine", () => {
  it("detects multiple violations on a misconfigured S3 bucket", () => {
    const findings = defaultGuardrailEngine.evaluate("AWS::S3::Bucket", {
      BucketName: "my-bad-bucket",
      // Missing PublicAccessBlockConfiguration → critical
      // Missing LifecycleConfiguration → warning
      // Missing BucketEncryption → critical
    });

    expect(findings.length).toBeGreaterThanOrEqual(3);

    const ruleIds = findings.map((f) => f.ruleId);
    expect(ruleIds).toContain("s3-public-access");
    expect(ruleIds).toContain("s3-missing-lifecycle");
    expect(ruleIds).toContain("missing-encryption");
  });

  it("returns empty array for a fully compliant S3 bucket", () => {
    const findings = defaultGuardrailEngine.evaluate("AWS::S3::Bucket", {
      BucketName: "my-good-bucket",
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      LifecycleConfiguration: {
        Rules: [{ Status: "Enabled", ExpirationInDays: 90 }],
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
    });

    expect(findings).toHaveLength(0);
  });

  it("returns empty array for resource types with no guardrail rules", () => {
    const findings = defaultGuardrailEngine.evaluate("AWS::Lambda::Function", {
      FunctionName: "my-function",
    });
    expect(findings).toHaveLength(0);
  });
});

describe("GuardrailEngine performance", () => {
  it("evaluates all 5 rules x 100 iterations in <100ms", () => {
    const start = performance.now();

    for (let i = 0; i < 100; i++) {
      // S3 bucket with violations
      defaultGuardrailEngine.evaluate("AWS::S3::Bucket", {
        BucketName: `bucket-${i}`,
      });

      // IAM role with violations
      defaultGuardrailEngine.evaluate("AWS::IAM::Role", {
        AssumeRolePolicyDocument: {
          Statement: [{ Action: "*", Resource: "*" }],
        },
      });

      // Auto-scaling without MaxSize
      defaultGuardrailEngine.evaluate("AWS::AutoScaling::AutoScalingGroup", {
        MinSize: "1",
      });

      // RDS without encryption
      defaultGuardrailEngine.evaluate("AWS::RDS::DBInstance", {
        DBInstanceClass: "db.t3.micro",
      });

      // Clean S3 bucket
      defaultGuardrailEngine.evaluate("AWS::S3::Bucket", {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        LifecycleConfiguration: { Rules: [{}] },
        BucketEncryption: { SSE: "AES256" },
      });
    }

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});
