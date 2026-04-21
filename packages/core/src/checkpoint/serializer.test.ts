/**
 * Tests for `serializeCheckpoint`.
 *
 * Focus areas (Story e92.1.d — Epic 89 C-05):
 *   - Per-queue `desiredState` round-trips (no longer hardcoded `{}`).
 *   - `currentResourceIndex` + `completedResources` emitted with
 *     defaults for pre-Epic-92 callers.
 *   - Redaction fires on per-queue `desiredState` too, not just the
 *     top-level field.
 *   - Pre-Epic-92 callers that don't pass the new fields still get
 *     schema-valid output (regression guard for existing cli/mcp
 *     callsites that have not been updated yet).
 */

import { describe, it, expect } from "vitest";
import { PlanCheckpointSchema } from "../schema/checkpoint.js";
import {
  serializeCheckpoint,
  type SerializableGraphState,
} from "./serializer.js";

const baseState: SerializableGraphState = {
  runId: "550e8400-e29b-41d4-a716-446655440000",
  userIntent: "create an S3 bucket named logs-prod",
  resourceType: "AWS::S3::Bucket",
  desiredState: { BucketName: "logs-prod" },
  estimatedMonthlyCost: "$0.023/GB-month",
  preflightPassed: true,
};

describe("serializeCheckpoint", () => {
  it("emits a checkpoint that parses cleanly against the schema", () => {
    const cp = serializeCheckpoint(baseState);
    const result = PlanCheckpointSchema.safeParse(cp);
    expect(result.success).toBe(true);
  });

  it("emits currentResourceIndex=0 and completedResources=[] for pre-Epic-92 callers", () => {
    const cp = serializeCheckpoint(baseState);
    expect(cp.currentResourceIndex).toBe(0);
    expect(cp.completedResources).toEqual([]);
  });

  it("redacts sensitive values from top-level desiredState", () => {
    const cp = serializeCheckpoint({
      ...baseState,
      resourceType: "AWS::RDS::DBInstance",
      desiredState: {
        DBInstanceIdentifier: "prod-db",
        MasterUserPassword: "hunter2-super-secret",
      },
    });
    expect(cp.desiredState["MasterUserPassword"]).not.toBe(
      "hunter2-super-secret",
    );
  });

  // ─── Story e92.1.d — per-queue desiredState (C-05 fix) ───────────────
  describe("Story e92.1.d — per-queue desiredState persistence", () => {
    it("persists fully-elicited desiredState from each resourceQueue entry", () => {
      const state: SerializableGraphState = {
        ...baseState,
        resourceType: "AWS::Lambda::Function",
        resourcePattern: { patternId: "lambda-with-exec-role" },
        resourceQueue: [
          {
            resourceId: "iam-execution-role",
            resourceType: "AWS::IAM::Role",
            displayName: "Lambda Execution Role",
            desiredState: {
              RoleName: "assignee-iam-execution-role",
              AssumeRolePolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { Service: "lambda.amazonaws.com" },
                    Action: "sts:AssumeRole",
                  },
                ],
              },
            },
          },
          {
            resourceId: "lambda-fn",
            resourceType: "AWS::Lambda::Function",
            displayName: "Lambda Function",
            desiredState: {
              FunctionName: "assignee-lambda-fn",
              Runtime: "nodejs22.x",
              Handler: "index.handler",
            },
          },
        ],
      };
      const cp = serializeCheckpoint(state);
      expect(cp.resourceQueue).toHaveLength(2);
      expect(cp.resourceQueue?.[0]?.desiredState).toMatchObject({
        RoleName: "assignee-iam-execution-role",
      });
      expect(cp.resourceQueue?.[1]?.desiredState).toMatchObject({
        FunctionName: "assignee-lambda-fn",
        Runtime: "nodejs22.x",
      });
    });

    it("falls back to {} when caller omits per-queue desiredState (pre-Epic-92 compat)", () => {
      const state: SerializableGraphState = {
        ...baseState,
        resourceQueue: [
          {
            resourceId: "iam-role",
            resourceType: "AWS::IAM::Role",
            displayName: "Role",
            // no desiredState property
          },
        ],
      };
      const cp = serializeCheckpoint(state);
      expect(cp.resourceQueue?.[0]?.desiredState).toEqual({});
    });

    it("redacts sensitive fields inside per-queue desiredState", () => {
      const state: SerializableGraphState = {
        ...baseState,
        resourceQueue: [
          {
            resourceId: "rds-db",
            resourceType: "AWS::RDS::DBInstance",
            displayName: "Primary DB",
            desiredState: {
              DBInstanceIdentifier: "prod-db",
              MasterUserPassword: "hunter2-super-secret",
            },
          },
        ],
      };
      const cp = serializeCheckpoint(state);
      const persisted = cp.resourceQueue?.[0]?.desiredState ?? {};
      expect(persisted["MasterUserPassword"]).not.toBe("hunter2-super-secret");
      // Non-sensitive peer survives redaction.
      expect(persisted["DBInstanceIdentifier"]).toBe("prod-db");
    });

    it("emits currentResourceIndex verbatim when caller supplies it", () => {
      const cp = serializeCheckpoint({
        ...baseState,
        currentResourceIndex: 3,
      });
      expect(cp.currentResourceIndex).toBe(3);
    });

    it("emits completedResources with only ARN + type (drops graph-internal fields)", () => {
      const cp = serializeCheckpoint({
        ...baseState,
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
      });
      expect(cp.completedResources).toEqual([
        {
          resourceArn:
            "arn:aws:iam::111111111111:role/assignee-iam-execution-role",
          resourceType: "AWS::IAM::Role",
        },
        {
          resourceArn: "arn:aws:lambda:us-east-1:111111111111:function:my-fn",
          resourceType: "AWS::Lambda::Function",
        },
      ]);
    });

    it("filters out completedResources entries without an ARN (half-provisioned failures)", () => {
      const cp = serializeCheckpoint({
        ...baseState,
        completedResources: [
          {
            resourceArn: "arn:aws:s3:::my-bucket",
            resourceType: "AWS::S3::Bucket",
          },
          // no ARN — half-provisioned / failure record
          { resourceType: "AWS::Lambda::Function" },
          {
            resourceArn: "",
            resourceType: "AWS::IAM::Role",
          },
        ],
      });
      expect(cp.completedResources).toEqual([
        {
          resourceArn: "arn:aws:s3:::my-bucket",
          resourceType: "AWS::S3::Bucket",
        },
      ]);
    });
  });

  describe("round-trip through PlanCheckpointSchema", () => {
    it("compound checkpoint with resume state round-trips without loss", () => {
      const state: SerializableGraphState = {
        runId: "ae5a006f-e4d9-4819-8788-c35b5dab3723",
        userIntent: "Create a serverless API with Lambda and API Gateway",
        resourceType: "AWS::Logs::LogGroup",
        resourcePattern: { patternId: "serverless-api" },
        desiredState: {
          LogGroupName: "/aws/apigateway/serverless-api",
          RetentionInDays: 14,
        },
        estimatedMonthlyCost: "N/A",
        preflightPassed: true,
        resourceQueue: [
          {
            resourceId: "iam-execution-role",
            resourceType: "AWS::IAM::Role",
            displayName: "Lambda Execution Role",
            desiredState: {
              RoleName: "assignee-iam-execution-role-ae5a006f",
            },
          },
          {
            resourceId: "lambda-fn",
            resourceType: "AWS::Lambda::Function",
            displayName: "Lambda Function",
            desiredState: {
              FunctionName: "assignee-lambda-fn-ae5a006f",
              Runtime: "nodejs22.x",
            },
          },
          {
            resourceId: "access-log-group",
            resourceType: "AWS::Logs::LogGroup",
            displayName: "API Gateway Access LogGroup",
            desiredState: {
              LogGroupName: "/aws/apigateway/serverless-api",
              RetentionInDays: 14,
            },
          },
        ],
        currentResourceIndex: 2,
        completedResources: [
          {
            resourceArn:
              "arn:aws:iam::111111111111:role/assignee-iam-execution-role-ae5a006f",
            resourceType: "AWS::IAM::Role",
          },
          {
            resourceArn:
              "arn:aws:lambda:us-east-1:111111111111:function:assignee-lambda-fn-ae5a006f",
            resourceType: "AWS::Lambda::Function",
          },
        ],
      };
      const cp = serializeCheckpoint(state);
      // JSON round-trip + schema parse to guarantee on-disk fidelity.
      const asJson = JSON.parse(JSON.stringify(cp));
      const parsed = PlanCheckpointSchema.safeParse(asJson);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.currentResourceIndex).toBe(2);
        expect(parsed.data.completedResources).toHaveLength(2);
        expect(parsed.data.resourceQueue).toHaveLength(3);
        expect(parsed.data.resourceQueue?.[1]?.desiredState).toMatchObject({
          FunctionName: "assignee-lambda-fn-ae5a006f",
          Runtime: "nodejs22.x",
        });
        expect(parsed.data.resourcePatternId).toBe("serverless-api");
      }
    });
  });
});
