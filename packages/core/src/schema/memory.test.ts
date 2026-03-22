import { describe, it, expect } from "vitest";
import {
  ProvisionRecordSchema,
  ProvisionLogSchema,
  FailureRecordSchema,
  FailureLogSchema,
  PatternRecordSchema,
  PatternLogSchema,
} from "./memory.js";

describe("ProvisionRecordSchema", () => {
  const valid = {
    runId: "550e8400-e29b-41d4-a716-446655440000",
    resourceType: "AWS::S3::Bucket",
    resourceArn: "arn:aws:s3:::my-bucket",
    region: "us-east-1",
    desiredStateHash: "abc123def456",
    estimatedMonthlyCost: "$0.023/GB-month",
    timestamp: "2026-03-22T10:00:00.000Z",
  };

  it("parses a valid provision record", () => {
    const result = ProvisionRecordSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects missing runId", () => {
    const { runId: _, ...noRunId } = valid;
    const result = ProvisionRecordSchema.safeParse(noRunId);
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID runId", () => {
    const result = ProvisionRecordSchema.safeParse({
      ...valid,
      runId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid timestamp", () => {
    const result = ProvisionRecordSchema.safeParse({
      ...valid,
      timestamp: "not-a-date",
    });
    expect(result.success).toBe(false);
  });

  it("validates an array via ProvisionLogSchema", () => {
    const result = ProvisionLogSchema.safeParse([valid, valid]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(2);
    }
  });

  it("rejects array with invalid record via ProvisionLogSchema", () => {
    const result = ProvisionLogSchema.safeParse([valid, { bad: true }]);
    expect(result.success).toBe(false);
  });
});

describe("FailureRecordSchema", () => {
  const valid = {
    runId: "550e8400-e29b-41d4-a716-446655440000",
    resourceType: "AWS::Lambda::Function",
    errorCode: "ResourceConflict",
    errorMessage: "Function already exists",
    suggestedFix: "Use a different function name",
    timestamp: "2026-03-22T10:00:00.000Z",
  };

  it("parses a valid failure record", () => {
    const result = FailureRecordSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects missing errorCode", () => {
    const { errorCode: _, ...noCode } = valid;
    const result = FailureRecordSchema.safeParse(noCode);
    expect(result.success).toBe(false);
  });

  it("validates an array via FailureLogSchema", () => {
    const result = FailureLogSchema.safeParse([valid]);
    expect(result.success).toBe(true);
  });
});

describe("PatternRecordSchema", () => {
  const valid = {
    pattern: "serverless-api",
    optionsSelected: { runtime: "nodejs22.x" },
    count: 3,
    lastUsed: "2026-03-22T10:00:00.000Z",
  };

  it("parses a valid pattern record", () => {
    const result = PatternRecordSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects zero count", () => {
    const result = PatternRecordSchema.safeParse({ ...valid, count: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects negative count", () => {
    const result = PatternRecordSchema.safeParse({ ...valid, count: -1 });
    expect(result.success).toBe(false);
  });

  it("validates an array via PatternLogSchema", () => {
    const result = PatternLogSchema.safeParse([valid, valid]);
    expect(result.success).toBe(true);
  });
});
