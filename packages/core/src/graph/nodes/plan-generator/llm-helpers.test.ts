/**
 * Unit tests for plan-generator/llm-helpers.ts — focused on the core helpers:
 *   - `placeholderExamplesForType` resource-type-aware example list
 *     (closes the observability-leak half of Wave 2.d).
 *   - `validatePlanShape` dispatcher integration (via re-export from
 *     llm-validators.ts — confirms the re-export wiring is intact).
 *
 * Per-type validator tests (validateDynamoDbKeySchema, validateCloudFrontOrigins,
 * validateIamRoleShape, etc.) live in the companion file llm-validators.test.ts.
 *
 * Fixtures are derived from real LLM outputs captured during Epic 92 agent
 * dogfooding (see `_bmad-output/implementation-artifacts/epic-92-findings-a.md`
 * F-A-16 for the DDB example; `epic-92-findings-c.md` for the CloudFront
 * example-origin case).
 */
import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "@/index.js";
import {
  placeholderExamplesForType,
  validatePlanShape,
} from "./llm-helpers.js";

// ── placeholderExamplesForType — resource-typed prompt rule 7 ───────────────

describe("placeholderExamplesForType", () => {
  it("returns Lambda-specific IAM role ARN example for Lambda functions", () => {
    const examples = placeholderExamplesForType(RESOURCE_TYPES.LAMBDA_FUNCTION);
    expect(examples).toContain("arn:aws:iam::123456789012:role/my-role");
    expect(examples).toContain("my-function");
    expect(examples).toContain("my-resource");
  });

  it("returns IAM-role-specific ARN example for IAM roles", () => {
    const examples = placeholderExamplesForType(RESOURCE_TYPES.IAM_ROLE);
    expect(examples).toContain("arn:aws:iam::123456789012:role/my-role");
  });

  it("returns EC2-specific examples for EC2 instances (ami / key-pair / subnet / sg)", () => {
    const examples = placeholderExamplesForType(RESOURCE_TYPES.EC2_INSTANCE);
    expect(examples).toContain("ami-0abcdef1234567890");
    expect(examples).toContain("my-key-pair");
    expect(examples).toContain("subnet-0abc1234");
    expect(examples).toContain("sg-0123456789abcdef0");
  });

  it("does NOT include Lambda IAM role ARN example for SNS topics", () => {
    const examples = placeholderExamplesForType(RESOURCE_TYPES.SNS_TOPIC);
    expect(examples).not.toContain("arn:aws:iam::123456789012:role/my-role");
    expect(examples).toContain("my-topic");
    expect(examples).toContain("my-resource");
  });

  it("does NOT include EC2 AMI example for SQS queues", () => {
    const examples = placeholderExamplesForType(RESOURCE_TYPES.SQS_QUEUE);
    expect(examples).not.toContain("ami-0abcdef1234567890");
    expect(examples).toContain("my-queue");
  });

  it("does NOT include IAM role ARN for DynamoDB tables", () => {
    const examples = placeholderExamplesForType(RESOURCE_TYPES.DYNAMODB_TABLE);
    expect(examples).not.toContain("arn:aws:iam::123456789012:role/my-role");
    expect(examples).toContain("my-table");
  });

  it("falls back to the universal example list for unknown resource types", () => {
    const examples = placeholderExamplesForType("AWS::Unknown::Resource");
    expect(examples).toEqual(["my-resource"]);
  });

  it("falls back to universal list for empty-string resource type", () => {
    // Defensive: buildPrompt passes `state.resourceType ?? ""`.
    const examples = placeholderExamplesForType("");
    expect(examples).toEqual(["my-resource"]);
  });
});

// ── validatePlanShape re-export wiring check ─────────────────────────────────
// Confirms the re-export from llm-validators.ts is correctly wired through
// llm-helpers.ts so existing callers (plan-generator.ts) still work.

describe("validatePlanShape (re-export wiring)", () => {
  it("dispatches to the DDB validator for AWS::DynamoDB::Table", () => {
    const err = validatePlanShape(
      {
        KeySchema: [{ AttributeName: "orphan", KeyType: "HASH" }],
        AttributeDefinitions: [],
      },
      RESOURCE_TYPES.DYNAMODB_TABLE,
    );
    expect(err).not.toBeNull();
    expect(err).toContain("'orphan'");
  });

  it("returns null for resource types with no validator registered", () => {
    expect(
      validatePlanShape({ BucketName: "my-bucket" }, RESOURCE_TYPES.S3_BUCKET),
    ).toBeNull();
  });
});
