import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PlanCheckpointSchema, CHECKPOINT_VERSION } from "./checkpoint.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(
  __dirname,
  "..",
  "test-fixtures",
  "checkpoints",
);
const readFixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf-8"));

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

  // ─── Story e92.1.d (Epic 89 C-05) additive-field backwards-compat ──
  describe("Story e92.1.d — resume-state fields (additive)", () => {
    it("defaults currentResourceIndex to 0 when absent (pre-Epic-92 checkpoint)", () => {
      // Uses the REAL preserved EC2 checkpoint shape from `.assignee/` —
      // no currentResourceIndex / completedResources on disk.
      const result = PlanCheckpointSchema.safeParse(validCheckpoint);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.currentResourceIndex).toBe(0);
      }
    });

    it("defaults completedResources to [] when absent (pre-Epic-92 checkpoint)", () => {
      const result = PlanCheckpointSchema.safeParse(validCheckpoint);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.completedResources).toEqual([]);
      }
    });

    it("parses Epic-92 checkpoint with explicit resume state", () => {
      const withResume = {
        ...validCheckpoint,
        currentResourceIndex: 2,
        completedResources: [
          {
            resourceArn:
              "arn:aws:iam::111111111111:role/assignee-iam-execution-role",
            resourceType: "AWS::IAM::Role",
          },
          {
            resourceArn: "arn:aws:lambda:us-east-1:111111111111:function:my-fn",
            resourceType: "AWS::Lambda::Function",
          },
        ],
      };
      const result = PlanCheckpointSchema.safeParse(withResume);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.currentResourceIndex).toBe(2);
        expect(result.data.completedResources).toHaveLength(2);
        expect(result.data.completedResources[0]?.resourceType).toBe(
          "AWS::IAM::Role",
        );
      }
    });

    it("rejects negative currentResourceIndex", () => {
      const bad = { ...validCheckpoint, currentResourceIndex: -1 };
      const result = PlanCheckpointSchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it("rejects non-integer currentResourceIndex", () => {
      const bad = { ...validCheckpoint, currentResourceIndex: 1.5 };
      const result = PlanCheckpointSchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it("rejects completedResources entries missing resourceArn", () => {
      const bad = {
        ...validCheckpoint,
        completedResources: [{ resourceType: "AWS::S3::Bucket" }],
      };
      const result = PlanCheckpointSchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it("rejects completedResources entries missing resourceType", () => {
      const bad = {
        ...validCheckpoint,
        completedResources: [{ resourceArn: "arn:aws:s3:::my-bucket" }],
      };
      const result = PlanCheckpointSchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it("preserves strict-mode unknown-field rejection alongside new defaults", () => {
      const withExtra = {
        ...validCheckpoint,
        currentResourceIndex: 1,
        completedResources: [],
        brandNewField: "nope",
      };
      const result = PlanCheckpointSchema.strict().safeParse(withExtra);
      expect(result.success).toBe(false);
    });
  });

  // ─── Real on-disk fixtures (copied + redacted from `.assignee/`) ────
  describe("parses real preserved checkpoints from `.assignee/`", () => {
    it("loads pre-Epic-92 EC2 baseline with defaults applied", () => {
      const raw = readFixture("single-ec2-baseline.json");
      const result = PlanCheckpointSchema.safeParse(raw);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.currentResourceIndex).toBe(0);
        expect(result.data.completedResources).toEqual([]);
        expect(result.data.resourceType).toBe("AWS::EC2::Instance");
      }
    });

    it("loads pre-Epic-92 scheduled-Lambda compound with defaults applied", () => {
      const raw = readFixture("single-lambda-scheduled.json");
      const result = PlanCheckpointSchema.safeParse(raw);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.currentResourceIndex).toBe(0);
        expect(result.data.completedResources).toEqual([]);
        expect(result.data.resourceQueue).toHaveLength(2);
        // Old fixtures still have desiredState:{} per resource — we
        // do not retroactively populate them.
        expect(result.data.resourceQueue?.[0]?.desiredState).toEqual({});
      }
    });

    it("loads post-Epic-92 compound serverless-api with explicit resume state", () => {
      const raw = readFixture("compound-serverless-api.json");
      const result = PlanCheckpointSchema.safeParse(raw);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.currentResourceIndex).toBe(3);
        expect(result.data.completedResources).toHaveLength(3);
        expect(result.data.resourceQueue).toHaveLength(8);
        // per-queue desiredState must be populated (this is the C-05 fix)
        expect(
          Object.keys(result.data.resourceQueue?.[0]?.desiredState ?? {})
            .length,
        ).toBeGreaterThan(0);
        // account-ID redaction confirmed at the fixture level
        const arn = result.data.completedResources[0]?.resourceArn ?? "";
        expect(arn).toContain("<ACCOUNT_ID>");
      }
    });
  });
});
