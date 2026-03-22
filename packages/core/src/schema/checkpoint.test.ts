import { describe, it, expect } from "vitest";
import { PlanCheckpointSchema, CHECKPOINT_VERSION } from "./checkpoint.js";

describe("PlanCheckpointSchema", () => {
  const validCheckpoint = {
    checkpoint_version: "1",
    created_at: "2026-03-22T10:00:00.000Z",
    ttl_hours: 72,
    runId: "550e8400-e29b-41d4-a716-446655440000",
    userIntent: "create an S3 bucket named logs-prod",
    resourceType: "AWS::S3::Bucket",
    desiredState: { BucketName: "logs-prod" },
    estimatedMonthlyCost: "$0.023/GB-month",
    preflightPassed: true,
    elicitedOptions: { Versioning: "Enabled" },
  };

  it("parses a valid checkpoint with all required fields", () => {
    const result = PlanCheckpointSchema.safeParse(validCheckpoint);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.checkpoint_version).toBe("1");
      expect(result.data.runId).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(result.data.resourcePatternId).toBeUndefined();
      expect(result.data.resourceQueue).toBeUndefined();
      expect(result.data.policyApprovalStatus).toBeUndefined();
    }
  });

  it("parses a checkpoint with optional policyApprovalStatus", () => {
    const withPolicy = {
      ...validCheckpoint,
      policyApprovalStatus: {
        validatedAt: "2026-03-22T10:00:00.000Z",
        policyVersion: "1.0",
        passed: true,
      },
    };
    const result = PlanCheckpointSchema.safeParse(withPolicy);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.policyApprovalStatus?.passed).toBe(true);
      expect(result.data.policyApprovalStatus?.policyVersion).toBe("1.0");
    }
  });

  it("parses a compound pattern checkpoint with resourceQueue and resourcePatternId", () => {
    const compound = {
      ...validCheckpoint,
      resourcePatternId: "serverless-api",
      resourceQueue: [
        {
          resourceId: "iam-role",
          resourceType: "AWS::IAM::Role",
          displayName: "Lambda Execution Role",
          desiredState: { RoleName: "my-role" },
        },
        {
          resourceId: "lambda-fn",
          resourceType: "AWS::Lambda::Function",
          displayName: "API Handler",
          desiredState: { FunctionName: "my-fn" },
        },
      ],
    };
    const result = PlanCheckpointSchema.safeParse(compound);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourcePatternId).toBe("serverless-api");
      expect(result.data.resourceQueue).toHaveLength(2);
    }
  });

  it("rejects unknown fields in strict mode", () => {
    const withExtra = { ...validCheckpoint, unknownField: "oops" };
    const result = PlanCheckpointSchema.strict().safeParse(withExtra);
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const { runId: _, ...noRunId } = validCheckpoint;
    const result = PlanCheckpointSchema.safeParse(noRunId);
    expect(result.success).toBe(false);
  });

  it("rejects invalid checkpoint_version", () => {
    const bad = { ...validCheckpoint, checkpoint_version: "99" };
    const result = PlanCheckpointSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects non-positive ttl_hours", () => {
    const bad = { ...validCheckpoint, ttl_hours: 0 };
    const result = PlanCheckpointSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("exports CHECKPOINT_VERSION constant", () => {
    expect(CHECKPOINT_VERSION).toBe("1");
  });
});
