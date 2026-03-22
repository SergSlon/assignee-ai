/**
 * Unit tests for individual guardrail rules.
 * Each rule is tested independently with crafted desiredState objects.
 *
 * @see Story 10.4, Task 7.1
 */

import { describe, it, expect } from "vitest";
import { s3PublicAccessRule } from "../rules/s3-public-access.js";
import { s3MissingLifecycleRule } from "../rules/s3-missing-lifecycle.js";
import { missingEncryptionRule } from "../rules/missing-encryption.js";
import { iamWildcardActionsRule } from "../rules/iam-wildcard-actions.js";
import { autoscalingNoMaxSizeRule } from "../rules/autoscaling-no-maxsize.js";

// ── S3 Public Access Rule ────────────────────────────────────────────────────

describe("s3PublicAccessRule", () => {
  it("returns critical when PublicAccessBlockConfiguration is missing entirely", () => {
    const finding = s3PublicAccessRule.evaluate("AWS::S3::Bucket", {
      BucketName: "my-bucket",
    });
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("critical");
    expect(finding!.ruleId).toBe("s3-public-access");
    expect(finding!.message).toContain(
      "missing PublicAccessBlockConfiguration",
    );
  });

  it("returns critical when BlockPublicAcls is false", () => {
    const finding = s3PublicAccessRule.evaluate("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("critical");
    expect(finding!.message).toContain("BlockPublicAcls");
  });

  it("returns critical when multiple fields are false", () => {
    const finding = s3PublicAccessRule.evaluate("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: false,
        BlockPublicPolicy: false,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("critical");
    expect(finding!.message).toContain("BlockPublicAcls");
    expect(finding!.message).toContain("BlockPublicPolicy");
  });

  it("returns critical when a field is missing (undefined)", () => {
    const finding = s3PublicAccessRule.evaluate("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        // IgnorePublicAcls missing
        RestrictPublicBuckets: true,
      },
    });
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("critical");
  });

  it("returns null when all fields are true", () => {
    const finding = s3PublicAccessRule.evaluate("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    expect(finding).toBeNull();
  });
});

// ── S3 Missing Lifecycle Rule ────────────────────────────────────────────────

describe("s3MissingLifecycleRule", () => {
  it("returns warning when LifecycleConfiguration is missing", () => {
    const finding = s3MissingLifecycleRule.evaluate("AWS::S3::Bucket", {
      BucketName: "my-bucket",
    });
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("warning");
    expect(finding!.ruleId).toBe("s3-missing-lifecycle");
  });

  it("returns warning when LifecycleConfiguration is false", () => {
    const finding = s3MissingLifecycleRule.evaluate("AWS::S3::Bucket", {
      LifecycleConfiguration: false,
    });
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("warning");
  });

  it("returns warning when LifecycleConfiguration is empty object", () => {
    const finding = s3MissingLifecycleRule.evaluate("AWS::S3::Bucket", {
      LifecycleConfiguration: {},
    });
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("warning");
  });

  it("returns null when LifecycleConfiguration is present", () => {
    const finding = s3MissingLifecycleRule.evaluate("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: [{ Status: "Enabled", ExpirationInDays: 90 }],
      },
    });
    expect(finding).toBeNull();
  });
});

// ── Missing Encryption Rule ──────────────────────────────────────────────────

describe("missingEncryptionRule", () => {
  it("returns critical when S3 BucketEncryption is missing", () => {
    const finding = missingEncryptionRule.evaluate("AWS::S3::Bucket", {
      BucketName: "my-bucket",
    });
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("critical");
    expect(finding!.ruleId).toBe("missing-encryption");
    expect(finding!.message).toContain("S3");
  });

  it("returns critical when S3 BucketEncryption is false", () => {
    const finding = missingEncryptionRule.evaluate("AWS::S3::Bucket", {
      BucketEncryption: false,
    });
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("critical");
  });

  it("returns null when S3 BucketEncryption is present", () => {
    const finding = missingEncryptionRule.evaluate("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
    });
    expect(finding).toBeNull();
  });

  it("returns critical when RDS StorageEncrypted is missing", () => {
    const finding = missingEncryptionRule.evaluate("AWS::RDS::DBInstance", {
      DBInstanceClass: "db.t3.micro",
    });
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("critical");
    expect(finding!.message).toContain("RDS");
  });

  it("returns critical when RDS StorageEncrypted is false", () => {
    const finding = missingEncryptionRule.evaluate("AWS::RDS::DBInstance", {
      StorageEncrypted: false,
    });
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("critical");
  });

  it("returns null when RDS StorageEncrypted is true", () => {
    const finding = missingEncryptionRule.evaluate("AWS::RDS::DBInstance", {
      StorageEncrypted: true,
    });
    expect(finding).toBeNull();
  });
});

// ── IAM Wildcard Actions Rule ────────────────────────────────────────────────

describe("iamWildcardActionsRule", () => {
  it("returns critical when AssumeRolePolicyDocument has Action: *", () => {
    const finding = iamWildcardActionsRule.evaluate("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Effect: "Allow",
            Action: "*",
            Principal: { Service: "lambda.amazonaws.com" },
          },
        ],
      },
    });
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("critical");
    expect(finding!.message).toContain("Action: *");
  });

  it("returns critical when Action is array containing *", () => {
    const finding = iamWildcardActionsRule.evaluate("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Effect: "Allow",
            Action: ["*"],
            Principal: { Service: "lambda.amazonaws.com" },
          },
        ],
      },
    });
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("critical");
  });

  it("returns critical when inline policy has Resource: *", () => {
    const finding = iamWildcardActionsRule.evaluate("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Effect: "Allow",
            Action: "sts:AssumeRole",
            Principal: { Service: "lambda.amazonaws.com" },
          },
        ],
      },
      Policies: [
        {
          PolicyName: "my-policy",
          PolicyDocument: {
            Statement: [
              {
                Effect: "Allow",
                Action: "s3:GetObject",
                Resource: "*",
              },
            ],
          },
        },
      ],
    });
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("critical");
    expect(finding!.message).toContain("Resource: *");
  });

  it("returns critical when both Action and Resource are wildcards", () => {
    const finding = iamWildcardActionsRule.evaluate("AWS::IAM::Role", {
      Policies: [
        {
          PolicyName: "admin",
          PolicyDocument: {
            Statement: [
              {
                Effect: "Allow",
                Action: "*",
                Resource: "*",
              },
            ],
          },
        },
      ],
    });
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("critical");
    expect(finding!.message).toContain("Action: *");
    expect(finding!.message).toContain("Resource: *");
  });

  it("returns null when actions are scoped", () => {
    const finding = iamWildcardActionsRule.evaluate("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Effect: "Allow",
            Action: "sts:AssumeRole",
            Principal: { Service: "lambda.amazonaws.com" },
          },
        ],
      },
      Policies: [
        {
          PolicyName: "scoped-policy",
          PolicyDocument: {
            Statement: [
              {
                Effect: "Allow",
                Action: ["s3:GetObject", "s3:PutObject"],
                Resource: "arn:aws:s3:::my-bucket/*",
              },
            ],
          },
        },
      ],
    });
    expect(finding).toBeNull();
  });

  it("returns null when no policies are present", () => {
    const finding = iamWildcardActionsRule.evaluate("AWS::IAM::Role", {
      RoleName: "my-role",
    });
    expect(finding).toBeNull();
  });
});

// ── Auto-scaling MaxSize Rule ────────────────────────────────────────────────

describe("autoscalingNoMaxSizeRule", () => {
  it("returns warning when MaxSize is missing", () => {
    const finding = autoscalingNoMaxSizeRule.evaluate(
      "AWS::AutoScaling::AutoScalingGroup",
      {
        MinSize: "1",
        DesiredCapacity: "2",
      },
    );
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("warning");
    expect(finding!.ruleId).toBe("autoscaling-no-maxsize");
  });

  it("returns warning when MaxSize is null", () => {
    const finding = autoscalingNoMaxSizeRule.evaluate(
      "AWS::AutoScaling::AutoScalingGroup",
      {
        MinSize: "1",
        MaxSize: null as unknown,
      },
    );
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe("warning");
  });

  it("returns null when MaxSize is present", () => {
    const finding = autoscalingNoMaxSizeRule.evaluate(
      "AWS::AutoScaling::AutoScalingGroup",
      {
        MinSize: "1",
        MaxSize: "10",
        DesiredCapacity: "2",
      },
    );
    expect(finding).toBeNull();
  });

  it("returns null when MaxSize is 0 (explicitly set)", () => {
    const finding = autoscalingNoMaxSizeRule.evaluate(
      "AWS::AutoScaling::AutoScalingGroup",
      {
        MaxSize: 0,
      },
    );
    expect(finding).toBeNull();
  });
});
