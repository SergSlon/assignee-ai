/**
 * Unit tests for plan-generator/llm-helpers.ts — focused on the Epic 92
 * Wave 2.d additions:
 *   - `placeholderExamplesForType` resource-type-aware example list
 *     (closes the observability-leak half of Wave 2.d).
 *   - `validateDynamoDbKeySchema` / `validateCloudFrontOrigins` /
 *     `validatePlanShape` plan-time rejectors (closes A-16 plan-time half
 *     + C-04 plan-time half).
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
  validateDynamoDbKeySchema,
  validateCloudFrontOrigins,
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

// ── validateDynamoDbKeySchema — A-16 plan-time half ─────────────────────────

describe("validateDynamoDbKeySchema", () => {
  it("passes when AttributeDefinitions covers every KeySchema name", () => {
    // Real LLM output shape for a simple hash-key table.
    const desiredState = {
      TableName: "payments-prod",
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
      BillingMode: "PAY_PER_REQUEST",
    };
    expect(validateDynamoDbKeySchema(desiredState)).toBeNull();
  });

  it("fails when KeySchema references an attribute missing from AttributeDefinitions (F-A-16 repro)", () => {
    // Exact repro from F-A-16: LLM used 'hashKey' in KeySchema but defined 'Id'.
    const desiredState = {
      TableName: "my-ddb-table",
      KeySchema: [{ AttributeName: "hashKey", KeyType: "HASH" }],
      AttributeDefinitions: [{ AttributeName: "Id", AttributeType: "S" }],
      BillingMode: "PAY_PER_REQUEST",
    };
    const err = validateDynamoDbKeySchema(desiredState);
    expect(err).not.toBeNull();
    expect(err).toContain("[ERROR]");
    expect(err).toContain("'hashKey'");
    expect(err).toContain("[FIX]");
    expect(err).toContain("AttributeDefinitions");
  });

  it("fails when GSI KeySchema references an attribute missing from AttributeDefinitions", () => {
    const desiredState = {
      TableName: "orders",
      KeySchema: [{ AttributeName: "orderId", KeyType: "HASH" }],
      AttributeDefinitions: [{ AttributeName: "orderId", AttributeType: "S" }],
      GlobalSecondaryIndexes: [
        {
          IndexName: "byStatus",
          KeySchema: [{ AttributeName: "status", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        },
      ],
      BillingMode: "PAY_PER_REQUEST",
    };
    const err = validateDynamoDbKeySchema(desiredState);
    expect(err).not.toBeNull();
    expect(err).toContain("'status'");
  });

  it("fails when LSI KeySchema references an attribute missing from AttributeDefinitions", () => {
    const desiredState = {
      TableName: "events",
      KeySchema: [
        { AttributeName: "userId", KeyType: "HASH" },
        { AttributeName: "eventId", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "userId", AttributeType: "S" },
        { AttributeName: "eventId", AttributeType: "S" },
      ],
      LocalSecondaryIndexes: [
        {
          IndexName: "byTimestamp",
          KeySchema: [
            { AttributeName: "userId", KeyType: "HASH" },
            { AttributeName: "timestamp", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "KEYS_ONLY" },
        },
      ],
    };
    const err = validateDynamoDbKeySchema(desiredState);
    expect(err).not.toBeNull();
    expect(err).toContain("'timestamp'");
  });

  it("passes when GSI KeySchema attributes are all defined", () => {
    const desiredState = {
      TableName: "orders",
      KeySchema: [{ AttributeName: "orderId", KeyType: "HASH" }],
      AttributeDefinitions: [
        { AttributeName: "orderId", AttributeType: "S" },
        { AttributeName: "status", AttributeType: "S" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "byStatus",
          KeySchema: [{ AttributeName: "status", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    };
    expect(validateDynamoDbKeySchema(desiredState)).toBeNull();
  });

  it("passes when KeySchema is absent (sanitizer short-circuit or invalid input)", () => {
    // Defensive — should not throw on a shape with no KeySchema at all.
    expect(validateDynamoDbKeySchema({ TableName: "no-schema" })).toBeNull();
  });

  it("lists multiple missing attributes in a single error message", () => {
    const desiredState = {
      KeySchema: [
        { AttributeName: "a", KeyType: "HASH" },
        { AttributeName: "b", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [],
    };
    const err = validateDynamoDbKeySchema(desiredState);
    expect(err).not.toBeNull();
    expect(err).toContain("'a'");
    expect(err).toContain("'b'");
  });

  it("treats a non-array AttributeDefinitions as empty (no defined attrs)", () => {
    const desiredState = {
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      AttributeDefinitions: "not an array",
    };
    const err = validateDynamoDbKeySchema(desiredState);
    expect(err).not.toBeNull();
    expect(err).toContain("'pk'");
  });
});

// ── validateCloudFrontOrigins — C-04 plan-time half ─────────────────────────

describe("validateCloudFrontOrigins", () => {
  it("passes when Origin has only S3OriginConfig", () => {
    const desiredState = {
      DistributionConfig: {
        Origins: {
          Items: [
            {
              Id: "s3-origin",
              DomainName: "my-bucket.s3.us-east-1.amazonaws.com",
              S3OriginConfig: { OriginAccessIdentity: "" },
            },
          ],
          Quantity: 1,
        },
      },
    };
    expect(validateCloudFrontOrigins(desiredState)).toBeNull();
  });

  it("passes when Origin has only CustomOriginConfig", () => {
    const desiredState = {
      DistributionConfig: {
        Origins: {
          Items: [
            {
              Id: "alb-origin",
              DomainName: "my-alb.us-east-1.elb.amazonaws.com",
              CustomOriginConfig: {
                HTTPPort: 80,
                HTTPSPort: 443,
                OriginProtocolPolicy: "https-only",
              },
            },
          ],
          Quantity: 1,
        },
      },
    };
    expect(validateCloudFrontOrigins(desiredState)).toBeNull();
  });

  it("fails when Origin has BOTH S3OriginConfig AND CustomOriginConfig (C-04 repro)", () => {
    // LLM-captured shape — both configs set because the LLM couldn't decide.
    const desiredState = {
      DistributionConfig: {
        Origins: {
          Items: [
            {
              Id: "ambiguous-origin",
              DomainName: "example-origin.com",
              S3OriginConfig: { OriginAccessIdentity: "" },
              CustomOriginConfig: {
                HTTPPort: 80,
                HTTPSPort: 443,
                OriginProtocolPolicy: "https-only",
              },
            },
          ],
          Quantity: 1,
        },
      },
    };
    const err = validateCloudFrontOrigins(desiredState);
    expect(err).not.toBeNull();
    expect(err).toContain("[ERROR]");
    expect(err).toContain("'ambiguous-origin'");
    expect(err).toContain("S3OriginConfig");
    expect(err).toContain("CustomOriginConfig");
    expect(err).toContain("[FIX]");
  });

  it("fails when any one of multiple Origins has both configs", () => {
    const desiredState = {
      DistributionConfig: {
        Origins: {
          Items: [
            {
              Id: "good-s3",
              DomainName: "my-bucket.s3.amazonaws.com",
              S3OriginConfig: { OriginAccessIdentity: "" },
            },
            {
              Id: "bad-dual",
              DomainName: "mixed.example.com",
              S3OriginConfig: { OriginAccessIdentity: "" },
              CustomOriginConfig: {
                HTTPPort: 80,
                HTTPSPort: 443,
                OriginProtocolPolicy: "https-only",
              },
            },
          ],
          Quantity: 2,
        },
      },
    };
    const err = validateCloudFrontOrigins(desiredState);
    expect(err).not.toBeNull();
    expect(err).toContain("'bad-dual'");
  });

  it("uses 'index N' when the offending Origin has no Id", () => {
    const desiredState = {
      DistributionConfig: {
        Origins: {
          Items: [
            {
              DomainName: "no-id.example.com",
              S3OriginConfig: { OriginAccessIdentity: "" },
              CustomOriginConfig: {
                HTTPPort: 80,
                HTTPSPort: 443,
                OriginProtocolPolicy: "https-only",
              },
            },
          ],
          Quantity: 1,
        },
      },
    };
    const err = validateCloudFrontOrigins(desiredState);
    expect(err).not.toBeNull();
    expect(err).toContain("'index 0'");
  });

  it("handles bare-array Origins (LLM emitted non-canonical shape)", () => {
    // Some LLMs emit Origins as a bare array before the sanitizer wraps it.
    const desiredState = {
      DistributionConfig: {
        Origins: [
          {
            Id: "dual-bare",
            DomainName: "example.com",
            S3OriginConfig: { OriginAccessIdentity: "" },
            CustomOriginConfig: {
              HTTPPort: 80,
              HTTPSPort: 443,
              OriginProtocolPolicy: "https-only",
            },
          },
        ],
      },
    };
    const err = validateCloudFrontOrigins(desiredState);
    expect(err).not.toBeNull();
    expect(err).toContain("'dual-bare'");
  });

  it("passes when DistributionConfig is absent", () => {
    expect(validateCloudFrontOrigins({})).toBeNull();
  });

  it("passes when Origins is absent", () => {
    expect(
      validateCloudFrontOrigins({
        DistributionConfig: { DefaultRootObject: "index.html" },
      }),
    ).toBeNull();
  });
});

// ── validatePlanShape — resource-type dispatcher ────────────────────────────

describe("validatePlanShape", () => {
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

  it("dispatches to the CloudFront validator for AWS::CloudFront::Distribution", () => {
    const err = validatePlanShape(
      {
        DistributionConfig: {
          Origins: {
            Items: [
              {
                Id: "dual",
                DomainName: "ex.com",
                S3OriginConfig: { OriginAccessIdentity: "" },
                CustomOriginConfig: {
                  HTTPPort: 80,
                  HTTPSPort: 443,
                  OriginProtocolPolicy: "https-only",
                },
              },
            ],
            Quantity: 1,
          },
        },
      },
      RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
    );
    expect(err).not.toBeNull();
    expect(err).toContain("'dual'");
  });

  it("returns null for resource types with no validator registered", () => {
    expect(
      validatePlanShape({ BucketName: "my-bucket" }, RESOURCE_TYPES.S3_BUCKET),
    ).toBeNull();
    expect(
      validatePlanShape({ TopicName: "my-topic" }, RESOURCE_TYPES.SNS_TOPIC),
    ).toBeNull();
  });

  it("returns null for a DDB table shape that the Wave 1 sanitizer already fixed", () => {
    // Sanitizer outcome: missing AttributeDefinition auto-synthesised.
    const sanitized = {
      KeySchema: [{ AttributeName: "hashKey", KeyType: "HASH" }],
      AttributeDefinitions: [{ AttributeName: "hashKey", AttributeType: "S" }],
    };
    expect(
      validatePlanShape(sanitized, RESOURCE_TYPES.DYNAMODB_TABLE),
    ).toBeNull();
  });
});
