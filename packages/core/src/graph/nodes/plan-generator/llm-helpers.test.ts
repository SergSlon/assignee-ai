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
  LlmResponseTooLargeError,
  LlmPolicyShapeViolationError,
} from "@/errors.js";
import {
  placeholderExamplesForType,
  validatePlanShape,
  parseLlmJsonResponse,
  MAX_LLM_RESPONSE_BYTES,
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

// ── parseLlmJsonResponse — SEC-029 size guard + SEC-018 policy shape guard ────

describe("parseLlmJsonResponse — SEC-029: size guard", () => {
  it("parses a normal response without error", () => {
    const text = JSON.stringify({ BucketName: "my-test-bucket" });
    const result = parseLlmJsonResponse(text);
    expect(result).toEqual({ BucketName: "my-test-bucket" });
  });

  it("parses a response at exactly MAX_LLM_RESPONSE_BYTES without error", () => {
    // Build a JSON object whose serialized form is exactly MAX_LLM_RESPONSE_BYTES
    // by padding a string value to fill the budget.
    const overhead = '{"k":"'.length + '"}'.length; // 8 chars for wrapper
    const padLength = MAX_LLM_RESPONSE_BYTES - overhead;
    const text = JSON.stringify({ k: "a".repeat(padLength) });
    expect(text.length).toBe(MAX_LLM_RESPONSE_BYTES);
    const result = parseLlmJsonResponse(text);
    expect(typeof result["k"]).toBe("string");
  });

  it("throws LlmResponseTooLargeError when text exceeds MAX_LLM_RESPONSE_BYTES", () => {
    const oversizedText = "x".repeat(MAX_LLM_RESPONSE_BYTES + 1);
    expect(() => parseLlmJsonResponse(oversizedText)).toThrow(
      LlmResponseTooLargeError,
    );
  });

  it("LlmResponseTooLargeError carries actualBytes and maxBytes", () => {
    const size = MAX_LLM_RESPONSE_BYTES + 100;
    try {
      parseLlmJsonResponse("x".repeat(size));
      expect.fail("Should have thrown LlmResponseTooLargeError");
    } catch (err) {
      expect(err).toBeInstanceOf(LlmResponseTooLargeError);
      const e = err as LlmResponseTooLargeError;
      expect(e.actualBytes).toBe(size);
      expect(e.maxBytes).toBe(MAX_LLM_RESPONSE_BYTES);
      expect(e.message).toContain(String(size));
      expect(e.message).toContain(String(MAX_LLM_RESPONSE_BYTES));
    }
  });

  it("throws LlmResponseTooLargeError before attempting JSON.parse (invalid JSON but over limit)", () => {
    // Even if the text is not valid JSON, the size guard fires first.
    const notJson = "not-valid-json" + "x".repeat(MAX_LLM_RESPONSE_BYTES);
    expect(() => parseLlmJsonResponse(notJson)).toThrow(
      LlmResponseTooLargeError,
    );
  });

  it("strips markdown fences and parses correctly (regression)", () => {
    const text = '```json\n{ "BucketName": "my-bucket" }\n```';
    const result = parseLlmJsonResponse(text);
    expect(result).toEqual({ BucketName: "my-bucket" });
  });
});

describe("parseLlmJsonResponse — SEC-018: wildcard IAM policy shape guard", () => {
  it("passes a clean response with no IAM policy shape", () => {
    const result = parseLlmJsonResponse(
      JSON.stringify({
        FunctionName: "my-lambda",
        Runtime: "nodejs20.x",
        Role: "arn:aws:iam::111122223333:role/my-role",
      }),
    );
    expect(result["FunctionName"]).toBe("my-lambda");
  });

  it("throws LlmPolicyShapeViolationError for a top-level Statement with Action:* + Resource:*", () => {
    const adversarialOutput = JSON.stringify({
      Effect: "Allow",
      Action: "*",
      Resource: "*",
    });
    expect(() => parseLlmJsonResponse(adversarialOutput)).toThrow(
      LlmPolicyShapeViolationError,
    );
  });

  it("throws LlmPolicyShapeViolationError for Action array containing * + Resource:*", () => {
    const adversarialOutput = JSON.stringify({
      BucketName: "my-bucket",
      Statement: {
        Effect: "Allow",
        Action: ["s3:GetObject", "*"],
        Resource: "*",
      },
    });
    expect(() => parseLlmJsonResponse(adversarialOutput)).toThrow(
      LlmPolicyShapeViolationError,
    );
  });

  it("throws LlmPolicyShapeViolationError for deeply nested wildcard policy in a Lambda Policies property", () => {
    // Simulates an adversarial prompt that embeds wildcard policy in a
    // Lambda FunctionConfiguration.Policies nested structure.
    const adversarialOutput = JSON.stringify({
      FunctionName: "innocent-lambda",
      Runtime: "nodejs20.x",
      Policies: [
        {
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
    expect(() => parseLlmJsonResponse(adversarialOutput)).toThrow(
      LlmPolicyShapeViolationError,
    );
  });

  it("LlmPolicyShapeViolationError carries the violating path", () => {
    const adversarialOutput = JSON.stringify({
      Effect: "Allow",
      Action: "*",
      Resource: "*",
    });
    try {
      parseLlmJsonResponse(adversarialOutput);
      expect.fail("Should have thrown LlmPolicyShapeViolationError");
    } catch (err) {
      expect(err).toBeInstanceOf(LlmPolicyShapeViolationError);
      const e = err as LlmPolicyShapeViolationError;
      expect(typeof e.violatingPath).toBe("string");
      expect(e.violatingPath.length).toBeGreaterThan(0);
      expect(e.message).toContain("Action:*");
      expect(e.message).toContain("Resource:*");
    }
  });

  it("does NOT throw for Action:* with a scoped Resource (not wildcarded)", () => {
    // Resource is a specific ARN — not a wildcard. This is unusual but
    // syntactically valid and not the attack pattern we guard against.
    const output = JSON.stringify({
      Effect: "Allow",
      Action: "*",
      Resource: "arn:aws:s3:::specific-bucket",
    });
    // Should parse without error
    const result = parseLlmJsonResponse(output);
    expect(result["Effect"]).toBe("Allow");
  });

  it("does NOT throw for Resource:* with a scoped Action (not wildcarded)", () => {
    const output = JSON.stringify({
      Effect: "Allow",
      Action: "s3:GetObject",
      Resource: "*",
    });
    const result = parseLlmJsonResponse(output);
    expect(result["Effect"]).toBe("Allow");
  });

  it("does NOT throw for a normal S3 bucket properties object", () => {
    const output = JSON.stringify({
      BucketName: "my-safe-bucket",
      VersioningConfiguration: { Status: "Enabled" },
      Tags: [{ Key: "Env", Value: "prod" }],
    });
    const result = parseLlmJsonResponse(output);
    expect(result["BucketName"]).toBe("my-safe-bucket");
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
