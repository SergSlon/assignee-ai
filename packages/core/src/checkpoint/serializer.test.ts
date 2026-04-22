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

    it("Epic 94 N7 (C-02): derives currentResourceIndex from completedResources length, not from the overflowed in-memory value", () => {
      // Plan-mode formatter advances `currentResourceIndex` past the
      // end of the queue so the END router triggers — an overflow
      // that is graph-internal plumbing. On disk the semantic is
      // "next resource to apply", which equals the filtered
      // `completedResources.length`. Persisting the overflow caused
      // apply-resume to skip the entire queue (C-02 regression).
      //
      // Two-resource queue, 1 persistable completion → canonical
      // on-disk index is 1, regardless of the in-memory overflow.
      const cp = serializeCheckpoint({
        ...baseState,
        resourceQueue: [
          {
            resourceId: "iam-role",
            resourceType: "AWS::IAM::Role",
            displayName: "IAM Role",
          },
          {
            resourceId: "lambda-fn",
            resourceType: "AWS::Lambda::Function",
            displayName: "Lambda Fn",
          },
        ],
        // Simulate the post-plan overflow the formatter leaves on
        // the terminal graph state.
        currentResourceIndex: 2,
        completedResources: [
          {
            resourceArn:
              "arn:aws:iam::111111111111:role/assignee-iam-execution-role",
            resourceType: "AWS::IAM::Role",
          },
        ],
      });
      expect(cp.currentResourceIndex).toBe(1);
    });

    it("Epic 94 N7 (C-02): clamps an overflowed index with no completions back to 0", () => {
      // After plan with no apply: completedResources = [],
      // state.currentResourceIndex = queue.length. On-disk value
      // must be 0 — "next resource to apply is the first one" — so
      // apply-resume re-plans from the start instead of skipping
      // the whole queue.
      const cp = serializeCheckpoint({
        ...baseState,
        resourceQueue: [
          {
            resourceId: "iam-role",
            resourceType: "AWS::IAM::Role",
            displayName: "IAM Role",
          },
          {
            resourceId: "lambda-fn",
            resourceType: "AWS::Lambda::Function",
            displayName: "Lambda Fn",
          },
        ],
        currentResourceIndex: 2, // overflow past end
        completedResources: [],
      });
      expect(cp.currentResourceIndex).toBe(0);
    });

    it("Epic 94 N7 (C-02): preserves a mid-apply in-bounds index when it has no completions yet", () => {
      // Covers mid-apply crash recovery: the provisioner node may
      // have advanced `currentResourceIndex` but not yet written
      // an entry into `completedResources` (e.g. STATUS_POLLER
      // picks up after a crash between SUCCESS and the compound
      // formatter append). Preserving the in-memory value here
      // keeps resume from mistakenly re-planning a resource that
      // was actually in-flight.
      const cp = serializeCheckpoint({
        ...baseState,
        resourceQueue: [
          {
            resourceId: "iam-role",
            resourceType: "AWS::IAM::Role",
            displayName: "IAM Role",
          },
          {
            resourceId: "lambda-fn",
            resourceType: "AWS::Lambda::Function",
            displayName: "Lambda Fn",
          },
        ],
        currentResourceIndex: 1, // in bounds, mid-apply-pending
        completedResources: [],
      });
      expect(cp.currentResourceIndex).toBe(1);
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

  // ── Epic 94 Wave 3 N7 (C-02): full plan → serialize → load → resume ──
  describe("Epic 94 N7 (C-02) — full apply-resume cycle fixture", () => {
    /**
     * Simulates the exact terminal-state shape the CLI's plan orchestrator
     * produces after a 3-resource compound plan completes with
     * `--no-apply`:
     *   - `currentResourceIndex` overflows past the end of the queue
     *     (set by `result-formatter`'s plan-mode advance when
     *     `nextIndex >= resourceQueue.length`).
     *   - `completedResources` is empty (nothing was applied yet).
     *   - `resourceQueue[i].desiredState` may be populated for slots
     *     the formatter stashed during iteration, plus the final slot
     *     carried on top-level `state.desiredState`.
     *
     * Contract after N7:
     *   - On-disk `currentResourceIndex === 0` so apply-resume starts
     *     the compound loop from the beginning (not skips to the end).
     *   - Every queue slot has a non-empty `desiredState` on disk (via
     *     per-slot state already present + top-level backfill for the
     *     final slot).
     *   - `JSON.parse(JSON.stringify(cp))` round-trips through the
     *     Zod schema without loss.
     */
    it("post-plan --no-apply state persists every slot and resets index to 0", () => {
      const state: SerializableGraphState = {
        runId: "0b4b0fa4-0b6a-4b6a-8b7a-000000000777",
        userIntent: "Create a serverless API with Lambda and API Gateway",
        // Top-level state = the LAST-planned resource's desiredState.
        // The formatter never stashed it back into the queue because
        // the terminal advance returns without writing to the slot.
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
              RoleName: "assignee-iam-execution-role-0b4b0fa4",
            },
          },
          {
            resourceId: "lambda-fn",
            resourceType: "AWS::Lambda::Function",
            displayName: "Lambda Function",
            desiredState: {
              FunctionName: "assignee-lambda-fn-0b4b0fa4",
              Runtime: "nodejs22.x",
            },
          },
          {
            // Terminal slot — no per-slot desiredState because the
            // formatter terminated after planning it. Top-level
            // `state.desiredState` above is what the plan produced.
            resourceId: "access-log-group",
            resourceType: "AWS::Logs::LogGroup",
            displayName: "API Gateway Access LogGroup",
          },
        ],
        // Overflow that the plan-mode formatter writes so the graph
        // router sends to END.
        currentResourceIndex: 3,
        completedResources: [],
      };

      const cp = serializeCheckpoint(state);

      // Clamp to 0 — nothing has been applied so apply-resume starts
      // at index 0 with a fresh compound loop.
      expect(cp.currentResourceIndex).toBe(0);
      expect(cp.completedResources).toEqual([]);

      // Every queue slot has non-empty desiredState on disk.
      expect(cp.resourceQueue).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        const slotState = cp.resourceQueue?.[i]?.desiredState ?? {};
        expect(
          Object.keys(slotState).length,
          `slot ${i} (${cp.resourceQueue?.[i]?.resourceId}) must persist desiredState`,
        ).toBeGreaterThan(0);
      }

      // The terminal slot picked up its desiredState from the top-
      // level state via the N7 backfill rule.
      expect(cp.resourceQueue?.[2]?.desiredState).toMatchObject({
        LogGroupName: "/aws/apigateway/serverless-api",
        RetentionInDays: 14,
      });

      // JSON round-trip + schema parse — on-disk fidelity.
      const asJson = JSON.parse(JSON.stringify(cp));
      const parsed = PlanCheckpointSchema.safeParse(asJson);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.currentResourceIndex).toBe(0);
        expect(parsed.data.resourceQueue).toHaveLength(3);
        expect(parsed.data.resourceQueue?.[0]?.desiredState).toMatchObject({
          RoleName: "assignee-iam-execution-role-0b4b0fa4",
        });
      }
    });

    /**
     * Bulletproof mid-apply resume fixture: after apply has
     * successfully provisioned the first resource and crashed
     * before the second, the checkpoint must carry
     *   - `currentResourceIndex === 1` (next to apply is index 1),
     *   - one entry in `completedResources` with the real ARN,
     *   - per-slot desiredState for every queue entry so
     *     plan-generator can resume without re-running the LLM.
     */
    it("mid-apply resume state persists completions + index=1 when resource 0 of 2 has applied", () => {
      const state: SerializableGraphState = {
        runId: "aaaaaaaa-bbbb-cccc-dddd-000000000001",
        userIntent: "Create an S3 bucket + CloudFront distribution",
        resourceType: "AWS::CloudFront::Distribution",
        resourcePattern: { patternId: "static-website" },
        desiredState: {
          DistributionConfig: {
            Enabled: true,
            DefaultRootObject: "index.html",
          },
        },
        estimatedMonthlyCost: "$5.00/month",
        preflightPassed: true,
        resourceQueue: [
          {
            resourceId: "origin-bucket",
            resourceType: "AWS::S3::Bucket",
            displayName: "Origin Bucket",
            desiredState: {
              BucketName: "assignee-origin-bucket-aaaaaaaa",
            },
          },
          {
            resourceId: "cf-distro",
            resourceType: "AWS::CloudFront::Distribution",
            displayName: "CloudFront Distribution",
            desiredState: {
              DistributionConfig: {
                Enabled: true,
                DefaultRootObject: "index.html",
              },
            },
          },
        ],
        // In-memory value is 1 (pointing at the CF distro that was
        // mid-provision when we crashed) — persisted index must also
        // be 1 since there is exactly one completion.
        currentResourceIndex: 1,
        completedResources: [
          {
            resourceArn: "arn:aws:s3:::assignee-origin-bucket-aaaaaaaa",
            resourceType: "AWS::S3::Bucket",
          },
        ],
      };

      const cp = serializeCheckpoint(state);
      expect(cp.currentResourceIndex).toBe(1);
      expect(cp.completedResources).toHaveLength(1);
      expect(cp.completedResources[0]?.resourceArn).toBe(
        "arn:aws:s3:::assignee-origin-bucket-aaaaaaaa",
      );
      expect(cp.resourceQueue?.[0]?.desiredState).toMatchObject({
        BucketName: "assignee-origin-bucket-aaaaaaaa",
      });
      expect(cp.resourceQueue?.[1]?.desiredState).toMatchObject({
        DistributionConfig: { Enabled: true },
      });

      // Simulate load-side (JSON round-trip + schema parse).
      const asJson = JSON.parse(JSON.stringify(cp));
      const parsed = PlanCheckpointSchema.safeParse(asJson);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        // Resume contract: index equals completions length — the
        // marker-resolver uses `completedResources[i]` to key into
        // `resourceQueue[i]` for cross-resource references.
        expect(parsed.data.currentResourceIndex).toBe(
          parsed.data.completedResources.length,
        );
      }
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
