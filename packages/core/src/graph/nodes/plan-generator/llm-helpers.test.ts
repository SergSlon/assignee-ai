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
  validateIamRoleShape,
  validateLambdaCodeShape,
  validateEc2InstanceShape,
  validateSqsQueueShape,
  validateSnsTopicShape,
  validateSsmParameterShape,
  validateLogsLogGroupShape,
  validateApiGatewayV2ApiShape,
  validateSecretsManagerSecretShape,
  validateEc2VpcShape,
  validateEc2SubnetShape,
  validateRdsDbSubnetGroupShape,
  validateCloudWatchAlarmShape,
  validateElbv2LoadBalancerShape,
  validateEfsFileSystemShape,
  validateEventsRuleShape,
  validateKmsKeyShape,
  validateEc2SecurityGroupShape,
  validateEc2RouteTableShape,
  validateEc2NatGatewayShape,
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

// ── validateIamRoleShape ──────────────────────────────────────────────────────

describe("validateIamRoleShape", () => {
  it("returns null when AssumeRolePolicyDocument is present", () => {
    expect(
      validateIamRoleShape({
        RoleName: "my-role",
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
      }),
    ).toBeNull();
  });

  it("returns an error when AssumeRolePolicyDocument is missing", () => {
    const err = validateIamRoleShape({ RoleName: "my-role" });
    expect(err).not.toBeNull();
    expect(err).toContain("AssumeRolePolicyDocument");
    expect(err).toContain("[FIX]");
  });

  it("dispatches via validatePlanShape", () => {
    const err = validatePlanShape(
      { RoleName: "orphan-role" },
      RESOURCE_TYPES.IAM_ROLE,
    );
    expect(err).not.toBeNull();
    expect(err).toContain("AssumeRolePolicyDocument");
  });

  it("validatePlanShape returns null for valid IAM role", () => {
    expect(
      validatePlanShape(
        {
          RoleName: "my-role",
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "ec2.amazonaws.com" },
                Action: "sts:AssumeRole",
              },
            ],
          },
        },
        RESOURCE_TYPES.IAM_ROLE,
      ),
    ).toBeNull();
  });
});

// ── validateLambdaCodeShape ───────────────────────────────────────────────────

describe("validateLambdaCodeShape", () => {
  it("returns null for S3 deployment with both S3Bucket and S3Key", () => {
    expect(
      validateLambdaCodeShape({
        FunctionName: "my-fn",
        Runtime: "nodejs20.x",
        Handler: "index.handler",
        Code: { S3Bucket: "my-bucket", S3Key: "fn.zip" },
      }),
    ).toBeNull();
  });

  it("returns null for ZipFile inline code", () => {
    expect(
      validateLambdaCodeShape({
        FunctionName: "my-fn",
        Code: {
          ZipFile: "exports.handler = async () => ({ statusCode: 200 });",
        },
      }),
    ).toBeNull();
  });

  it("returns null for container image code", () => {
    expect(
      validateLambdaCodeShape({
        FunctionName: "my-fn",
        Code: {
          ImageUri:
            "123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:latest",
        },
      }),
    ).toBeNull();
  });

  it("returns null when Code is absent (no validator premise)", () => {
    expect(validateLambdaCodeShape({ FunctionName: "no-code" })).toBeNull();
  });

  it("returns an error when both ZipFile and S3Bucket+S3Key are specified", () => {
    const err = validateLambdaCodeShape({
      Code: {
        ZipFile: "exports.handler = async () => {};",
        S3Bucket: "my-bucket",
        S3Key: "fn.zip",
      },
    });
    expect(err).not.toBeNull();
    expect(err).toContain("multiple sources");
    expect(err).toContain("[FIX]");
  });

  it("returns an error when S3Bucket is set but S3Key is missing", () => {
    const err = validateLambdaCodeShape({
      Code: { S3Bucket: "my-bucket" },
    });
    expect(err).not.toBeNull();
    expect(err).toContain("S3Key is missing");
  });

  it("returns an error when S3Key is set but S3Bucket is missing", () => {
    const err = validateLambdaCodeShape({
      Code: { S3Key: "fn.zip" },
    });
    expect(err).not.toBeNull();
    expect(err).toContain("S3Bucket is missing");
  });

  it("dispatches via validatePlanShape", () => {
    const err = validatePlanShape(
      { Code: { S3Bucket: "my-bucket" } },
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    expect(err).not.toBeNull();
    expect(err).toContain("S3Key is missing");
  });
});

// ── validateEc2InstanceShape ──────────────────────────────────────────────────

describe("validateEc2InstanceShape", () => {
  it("returns null when ImageId is present", () => {
    expect(
      validateEc2InstanceShape({
        ImageId: "ami-0abcdef1234567890",
        InstanceType: "t3.micro",
      }),
    ).toBeNull();
  });

  it("returns an error when ImageId is missing", () => {
    const err = validateEc2InstanceShape({ InstanceType: "t3.micro" });
    expect(err).not.toBeNull();
    expect(err).toContain("ImageId");
    expect(err).toContain("[FIX]");
  });

  it("returns an error when ImageId is empty string", () => {
    const err = validateEc2InstanceShape({ ImageId: "" });
    expect(err).not.toBeNull();
    expect(err).toContain("ImageId");
  });

  it("dispatches via validatePlanShape", () => {
    const err = validatePlanShape(
      { InstanceType: "t3.micro" },
      RESOURCE_TYPES.EC2_INSTANCE,
    );
    expect(err).not.toBeNull();
    expect(err).toContain("ImageId");
  });
});

// ── validateSqsQueueShape ─────────────────────────────────────────────────────

describe("validateSqsQueueShape", () => {
  it("returns null for FIFO queue with .fifo suffix", () => {
    expect(
      validateSqsQueueShape({
        QueueName: "my-queue.fifo",
        FifoQueue: true,
        ContentBasedDeduplication: true,
      }),
    ).toBeNull();
  });

  it("returns null for standard queue without .fifo suffix", () => {
    expect(
      validateSqsQueueShape({ QueueName: "my-standard-queue" }),
    ).toBeNull();
  });

  it("returns null when QueueName is not set (auto-generated)", () => {
    expect(validateSqsQueueShape({ FifoQueue: true })).toBeNull();
  });

  it("returns an error when FifoQueue:true but name lacks .fifo suffix", () => {
    const err = validateSqsQueueShape({
      QueueName: "my-queue",
      FifoQueue: true,
    });
    expect(err).not.toBeNull();
    expect(err).toContain(".fifo");
    expect(err).toContain("[FIX]");
  });

  it("returns an error when name has .fifo suffix but FifoQueue is not true", () => {
    const err = validateSqsQueueShape({ QueueName: "my-queue.fifo" });
    expect(err).not.toBeNull();
    expect(err).toContain("FifoQueue is not set to true");
  });

  it("dispatches via validatePlanShape", () => {
    const err = validatePlanShape(
      { QueueName: "my-queue", FifoQueue: true },
      RESOURCE_TYPES.SQS_QUEUE,
    );
    expect(err).not.toBeNull();
    expect(err).toContain(".fifo");
  });
});

// ── validateSnsTopicShape ─────────────────────────────────────────────────────

describe("validateSnsTopicShape", () => {
  it("returns null for FIFO topic with .fifo suffix", () => {
    expect(
      validateSnsTopicShape({ TopicName: "my-topic.fifo", FifoTopic: true }),
    ).toBeNull();
  });

  it("returns null for standard topic without .fifo suffix", () => {
    expect(validateSnsTopicShape({ TopicName: "my-topic" })).toBeNull();
  });

  it("returns null when TopicName is absent", () => {
    expect(validateSnsTopicShape({ FifoTopic: true })).toBeNull();
  });

  it("returns an error when FifoTopic:true but name lacks .fifo suffix", () => {
    const err = validateSnsTopicShape({
      TopicName: "my-topic",
      FifoTopic: true,
    });
    expect(err).not.toBeNull();
    expect(err).toContain(".fifo");
    expect(err).toContain("[FIX]");
  });

  it("returns an error when name has .fifo suffix but FifoTopic is not true", () => {
    const err = validateSnsTopicShape({ TopicName: "my-topic.fifo" });
    expect(err).not.toBeNull();
    expect(err).toContain("FifoTopic is not set to true");
  });

  it("dispatches via validatePlanShape", () => {
    const err = validatePlanShape(
      { TopicName: "my-topic", FifoTopic: true },
      RESOURCE_TYPES.SNS_TOPIC,
    );
    expect(err).not.toBeNull();
    expect(err).toContain(".fifo");
  });
});

// ── validateSsmParameterShape ─────────────────────────────────────────────────

describe("validateSsmParameterShape", () => {
  it("returns null for Type: String", () => {
    expect(
      validateSsmParameterShape({
        Name: "/app/config",
        Type: "String",
        Value: "foo",
      }),
    ).toBeNull();
  });

  it("returns null for Type: StringList", () => {
    expect(
      validateSsmParameterShape({ Type: "StringList", Value: "a,b,c" }),
    ).toBeNull();
  });

  it("returns null for Type: SecureString", () => {
    expect(
      validateSsmParameterShape({ Type: "SecureString", Value: "secret" }),
    ).toBeNull();
  });

  it("returns null when Type is not specified", () => {
    expect(
      validateSsmParameterShape({ Name: "/app/config", Value: "foo" }),
    ).toBeNull();
  });

  it("returns an error for Type: string (lowercase)", () => {
    const err = validateSsmParameterShape({ Type: "string" });
    expect(err).not.toBeNull();
    expect(err).toContain('"string"');
    expect(err).toContain("[FIX]");
  });

  it("returns an error for CFN reference-syntax type value", () => {
    const err = validateSsmParameterShape({
      Type: "AWS::SSM::Parameter::Value<String>",
    });
    expect(err).not.toBeNull();
    expect(err).toContain("[FIX]");
  });

  it("dispatches via validatePlanShape", () => {
    const err = validatePlanShape(
      { Name: "/app/key", Type: "invalid-type" },
      RESOURCE_TYPES.SSM_PARAMETER,
    );
    expect(err).not.toBeNull();
    expect(err).toContain("invalid-type");
  });
});

// ── validateLogsLogGroupShape ─────────────────────────────────────────────────

describe("validateLogsLogGroupShape", () => {
  it("returns null when RetentionInDays is absent (indefinite retention)", () => {
    expect(validateLogsLogGroupShape({ LogGroupName: "/app/logs" })).toBeNull();
  });

  it("returns null for a valid RetentionInDays of 30", () => {
    expect(validateLogsLogGroupShape({ RetentionInDays: 30 })).toBeNull();
  });

  it("returns null for a valid RetentionInDays of 365", () => {
    expect(validateLogsLogGroupShape({ RetentionInDays: 365 })).toBeNull();
  });

  it("returns an error for an invalid RetentionInDays of 45", () => {
    const err = validateLogsLogGroupShape({ RetentionInDays: 45 });
    expect(err).not.toBeNull();
    expect(err).toContain("45");
    expect(err).toContain("[FIX]");
  });

  it("returns an error for RetentionInDays of 0", () => {
    const err = validateLogsLogGroupShape({ RetentionInDays: 0 });
    expect(err).not.toBeNull();
    expect(err).toContain("[FIX]");
  });

  it("dispatches via validatePlanShape", () => {
    const err = validatePlanShape(
      { LogGroupName: "/app/logs", RetentionInDays: 25 },
      RESOURCE_TYPES.LOGS_LOG_GROUP,
    );
    expect(err).not.toBeNull();
    expect(err).toContain("25");
  });
});

// ── validateApiGatewayV2ApiShape ──────────────────────────────────────────────

describe("validateApiGatewayV2ApiShape", () => {
  it("returns null for ProtocolType: HTTP", () => {
    expect(
      validateApiGatewayV2ApiShape({ Name: "my-api", ProtocolType: "HTTP" }),
    ).toBeNull();
  });

  it("returns null for ProtocolType: WEBSOCKET", () => {
    expect(
      validateApiGatewayV2ApiShape({
        Name: "my-ws",
        ProtocolType: "WEBSOCKET",
      }),
    ).toBeNull();
  });

  it("returns null when ProtocolType is not specified", () => {
    expect(validateApiGatewayV2ApiShape({ Name: "my-api" })).toBeNull();
  });

  it("returns an error for ProtocolType: REST (not supported by v2)", () => {
    const err = validateApiGatewayV2ApiShape({ ProtocolType: "REST" });
    expect(err).not.toBeNull();
    expect(err).toContain('"REST"');
    expect(err).toContain("[FIX]");
  });

  it("returns an error for lowercase protocol type", () => {
    const err = validateApiGatewayV2ApiShape({ ProtocolType: "http" });
    expect(err).not.toBeNull();
    expect(err).toContain('"http"');
  });

  it("dispatches via validatePlanShape", () => {
    const err = validatePlanShape(
      { Name: "my-api", ProtocolType: "grpc" },
      RESOURCE_TYPES.APIGATEWAYV2_API,
    );
    expect(err).not.toBeNull();
    expect(err).toContain('"grpc"');
  });
});

// ── validateSecretsManagerSecretShape ────────────────────────────────────────

describe("validateSecretsManagerSecretShape", () => {
  it("returns null when only SecretString is set", () => {
    expect(
      validateSecretsManagerSecretShape({
        Name: "my-secret",
        SecretString: '{"password":"hunter2"}',
      }),
    ).toBeNull();
  });

  it("returns null when only GenerateSecretString is set", () => {
    expect(
      validateSecretsManagerSecretShape({
        Name: "my-secret",
        GenerateSecretString: { PasswordLength: 32 },
      }),
    ).toBeNull();
  });

  it("returns null when neither is set (Secrets Manager allows empty)", () => {
    expect(validateSecretsManagerSecretShape({ Name: "my-secret" })).toBeNull();
  });

  it("returns an error when both SecretString and GenerateSecretString are set", () => {
    const err = validateSecretsManagerSecretShape({
      Name: "my-secret",
      SecretString: '{"password":"hunter2"}',
      GenerateSecretString: { PasswordLength: 32 },
    });
    expect(err).not.toBeNull();
    // The error must mention at least one of the two conflicting keys.
    const errStr = err ?? "";
    expect(
      errStr.includes("SecretString") ||
        errStr.includes("GenerateSecretString"),
    ).toBe(true);
    expect(err).toContain("[FIX]");
  });

  it("dispatches via validatePlanShape", () => {
    const err = validatePlanShape(
      {
        SecretString: "my-value",
        GenerateSecretString: { PasswordLength: 16 },
      },
      RESOURCE_TYPES.SECRETSMANAGER_SECRET,
    );
    expect(err).not.toBeNull();
  });
});

// ── validateEc2VpcShape ───────────────────────────────────────────────────────

describe("validateEc2VpcShape", () => {
  it("returns null when CidrBlock is present", () => {
    expect(validateEc2VpcShape({ CidrBlock: "10.0.0.0/16" })).toBeNull();
  });

  it("returns an error when CidrBlock is missing", () => {
    const err = validateEc2VpcShape({ EnableDnsSupport: true });
    expect(err).not.toBeNull();
    expect(err).toContain("CidrBlock");
    expect(err).toContain("[FIX]");
  });

  it("dispatches via validatePlanShape", () => {
    const err = validatePlanShape({}, RESOURCE_TYPES.EC2_VPC);
    expect(err).not.toBeNull();
    expect(err).toContain("CidrBlock");
  });
});

// ── validateEc2SubnetShape ────────────────────────────────────────────────────

describe("validateEc2SubnetShape", () => {
  it("returns null when CidrBlock and VpcId are both present", () => {
    expect(
      validateEc2SubnetShape({
        CidrBlock: "10.0.1.0/24",
        VpcId: "vpc-0abc1234",
      }),
    ).toBeNull();
  });

  it("returns an error when CidrBlock is missing", () => {
    const err = validateEc2SubnetShape({ VpcId: "vpc-0abc1234" });
    expect(err).not.toBeNull();
    expect(err).toContain("CidrBlock");
  });

  it("returns an error when VpcId is missing", () => {
    const err = validateEc2SubnetShape({ CidrBlock: "10.0.1.0/24" });
    expect(err).not.toBeNull();
    expect(err).toContain("VpcId");
  });

  it("dispatches via validatePlanShape (missing CidrBlock)", () => {
    const err = validatePlanShape(
      { VpcId: "vpc-0abc1234" },
      RESOURCE_TYPES.EC2_SUBNET,
    );
    expect(err).not.toBeNull();
    expect(err).toContain("CidrBlock");
  });
});

// ── validateRdsDbSubnetGroupShape ─────────────────────────────────────────────

describe("validateRdsDbSubnetGroupShape", () => {
  it("returns null when SubnetIds has 2 entries", () => {
    expect(
      validateRdsDbSubnetGroupShape({
        DBSubnetGroupDescription: "My subnet group",
        SubnetIds: ["subnet-0abc1234", "subnet-0def5678"],
      }),
    ).toBeNull();
  });

  it("returns null when SubnetIds has 3 entries", () => {
    expect(
      validateRdsDbSubnetGroupShape({
        SubnetIds: ["subnet-0abc1234", "subnet-0def5678", "subnet-0ghi9012"],
      }),
    ).toBeNull();
  });

  it("returns null when SubnetIds is not set (let CloudControl reject)", () => {
    expect(
      validateRdsDbSubnetGroupShape({
        DBSubnetGroupDescription: "My subnet group",
      }),
    ).toBeNull();
  });

  it("returns an error when SubnetIds has only 1 entry", () => {
    const err = validateRdsDbSubnetGroupShape({
      SubnetIds: ["subnet-0abc1234"],
    });
    expect(err).not.toBeNull();
    expect(err).toContain("1");
    expect(err).toContain("[FIX]");
  });

  it("dispatches via validatePlanShape", () => {
    const err = validatePlanShape(
      {
        DBSubnetGroupDescription: "group",
        SubnetIds: ["subnet-only-one"],
      },
      RESOURCE_TYPES.RDS_DB_SUBNET_GROUP,
    );
    expect(err).not.toBeNull();
  });
});

// ── validateCloudWatchAlarmShape ──────────────────────────────────────────────

describe("validateCloudWatchAlarmShape", () => {
  it("returns null for valid GreaterThanThreshold", () => {
    expect(
      validateCloudWatchAlarmShape({
        AlarmName: "my-alarm",
        ComparisonOperator: "GreaterThanThreshold",
        Threshold: 90,
        EvaluationPeriods: 1,
      }),
    ).toBeNull();
  });

  it("returns null for valid LessThanOrEqualToThreshold", () => {
    expect(
      validateCloudWatchAlarmShape({
        ComparisonOperator: "LessThanOrEqualToThreshold",
      }),
    ).toBeNull();
  });

  it("returns null when ComparisonOperator is absent", () => {
    expect(validateCloudWatchAlarmShape({ AlarmName: "my-alarm" })).toBeNull();
  });

  it("returns an error for abbreviated operator '>='", () => {
    const err = validateCloudWatchAlarmShape({ ComparisonOperator: ">=" });
    expect(err).not.toBeNull();
    expect(err).toContain('">="');
    expect(err).toContain("[FIX]");
  });

  it("returns an error for 'GreaterThan' (missing 'Threshold' suffix)", () => {
    const err = validateCloudWatchAlarmShape({
      ComparisonOperator: "GreaterThan",
    });
    expect(err).not.toBeNull();
    expect(err).toContain('"GreaterThan"');
  });

  it("dispatches via validatePlanShape", () => {
    const err = validatePlanShape(
      { ComparisonOperator: ">" },
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
    );
    expect(err).not.toBeNull();
  });
});

// ── validateElbv2LoadBalancerShape ────────────────────────────────────────────

describe("validateElbv2LoadBalancerShape", () => {
  it("returns null for Scheme: internet-facing", () => {
    expect(
      validateElbv2LoadBalancerShape({
        Name: "my-alb",
        Scheme: "internet-facing",
      }),
    ).toBeNull();
  });

  it("returns null for Scheme: internal", () => {
    expect(validateElbv2LoadBalancerShape({ Scheme: "internal" })).toBeNull();
  });

  it("returns null when Scheme is absent", () => {
    expect(validateElbv2LoadBalancerShape({ Name: "my-alb" })).toBeNull();
  });

  it("returns an error for Scheme: public", () => {
    const err = validateElbv2LoadBalancerShape({ Scheme: "public" });
    expect(err).not.toBeNull();
    expect(err).toContain('"public"');
    expect(err).toContain("[FIX]");
  });

  it("returns an error for Scheme: external", () => {
    const err = validateElbv2LoadBalancerShape({ Scheme: "external" });
    expect(err).not.toBeNull();
    expect(err).toContain('"external"');
  });

  it("dispatches via validatePlanShape", () => {
    const err = validatePlanShape(
      { Scheme: "private" },
      RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    );
    expect(err).not.toBeNull();
  });
});

// ── validateEfsFileSystemShape ────────────────────────────────────────────────

describe("validateEfsFileSystemShape", () => {
  it("returns null when KmsKeyId and Encrypted:true are both set", () => {
    expect(
      validateEfsFileSystemShape({
        Encrypted: true,
        KmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/mrk-abc123",
      }),
    ).toBeNull();
  });

  it("returns null when KmsKeyId is absent", () => {
    expect(validateEfsFileSystemShape({ Encrypted: true })).toBeNull();
  });

  it("returns null when neither KmsKeyId nor Encrypted is set", () => {
    expect(
      validateEfsFileSystemShape({ PerformanceMode: "generalPurpose" }),
    ).toBeNull();
  });

  it("returns an error when KmsKeyId is set without Encrypted:true", () => {
    const err = validateEfsFileSystemShape({
      KmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/mrk-abc123",
    });
    expect(err).not.toBeNull();
    expect(err).toContain("KmsKeyId");
    expect(err).toContain("Encrypted");
    expect(err).toContain("[FIX]");
  });

  it("returns an error when Encrypted is false but KmsKeyId is set", () => {
    const err = validateEfsFileSystemShape({
      Encrypted: false,
      KmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/mrk-abc123",
    });
    expect(err).not.toBeNull();
    expect(err).toContain("KmsKeyId");
  });

  it("dispatches via validatePlanShape", () => {
    const err = validatePlanShape(
      { KmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/mrk-abc123" },
      RESOURCE_TYPES.EFS_FILE_SYSTEM,
    );
    expect(err).not.toBeNull();
  });
});

// ── validateEventsRuleShape ───────────────────────────────────────────────────

describe("validateEventsRuleShape", () => {
  it("returns null when EventPattern is provided", () => {
    expect(
      validateEventsRuleShape({
        Name: "my-rule",
        EventPattern: { source: ["aws.ec2"] },
      }),
    ).toBeNull();
  });

  it("returns null when ScheduleExpression is provided", () => {
    expect(
      validateEventsRuleShape({
        Name: "my-rule",
        ScheduleExpression: "rate(5 minutes)",
      }),
    ).toBeNull();
  });

  it("returns null when both EventPattern and ScheduleExpression are provided", () => {
    expect(
      validateEventsRuleShape({
        EventPattern: { source: ["aws.ec2"] },
        ScheduleExpression: "rate(5 minutes)",
      }),
    ).toBeNull();
  });

  it("returns an error when neither EventPattern nor ScheduleExpression is set", () => {
    const err = validateEventsRuleShape({
      Name: "my-rule",
      Targets: [
        { Id: "target-1", Arn: "arn:aws:sqs:us-east-1:123456789012:my-queue" },
      ],
    });
    expect(err).not.toBeNull();
    expect(err).toContain("EventPattern");
    expect(err).toContain("ScheduleExpression");
    expect(err).toContain("[FIX]");
  });

  it("dispatches via validatePlanShape", () => {
    const err = validatePlanShape(
      { Name: "no-pattern-no-schedule" },
      RESOURCE_TYPES.EVENTS_RULE,
    );
    expect(err).not.toBeNull();
  });
});

// ── validateKmsKeyShape ───────────────────────────────────────────────────────

describe("validateKmsKeyShape", () => {
  it("returns null when KeyPolicy is present", () => {
    expect(
      validateKmsKeyShape({
        Description: "My key",
        KeyPolicy: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { AWS: "arn:aws:iam::123456789012:root" },
              Action: "kms:*",
              Resource: "*",
            },
          ],
        },
      }),
    ).toBeNull();
  });

  it("returns an error when KeyPolicy is absent", () => {
    const err = validateKmsKeyShape({ Description: "My key" });
    expect(err).not.toBeNull();
    expect(err).toContain("KeyPolicy");
    expect(err).toContain("[FIX]");
  });

  it("dispatches via validatePlanShape", () => {
    const err = validatePlanShape(
      { Description: "My key" },
      RESOURCE_TYPES.KMS_KEY,
    );
    expect(err).not.toBeNull();
    expect(err).toContain("KeyPolicy");
  });
});

// ── validateEc2SecurityGroupShape ─────────────────────────────────────────────

describe("validateEc2SecurityGroupShape", () => {
  it("returns null when VpcId is present", () => {
    expect(
      validateEc2SecurityGroupShape({
        GroupDescription: "My SG",
        VpcId: "vpc-0abc1234",
      }),
    ).toBeNull();
  });

  it("returns an error when VpcId is missing", () => {
    const err = validateEc2SecurityGroupShape({
      GroupDescription: "My SG",
    });
    expect(err).not.toBeNull();
    expect(err).toContain("VpcId");
    expect(err).toContain("[FIX]");
  });

  it("is NOT registered in PLAN_SHAPE_VALIDATORS (R10b-04 follow-up)", () => {
    // The validator is exported and unit-tested above, but the type
    // is intentionally NOT in PLAN_SHAPE_VALIDATORS — see registry
    // comment in llm-helpers.ts: --json mode plans without VpcId
    // are legitimate (CCAPI rejects at apply with the canonical AWS
    // error). Probe `e96.W3.N2 bp-sg-high-risk-fires-on-3306` relies
    // on this — strict pre-validation blocks BP-SG-004 from firing.
    const err = validatePlanShape(
      { GroupDescription: "My SG" },
      RESOURCE_TYPES.EC2_SECURITY_GROUP,
    );
    expect(err).toBeNull();
  });
});

// ── validateEc2RouteTableShape ────────────────────────────────────────────────

describe("validateEc2RouteTableShape", () => {
  it("returns null when VpcId is present", () => {
    expect(validateEc2RouteTableShape({ VpcId: "vpc-0abc1234" })).toBeNull();
  });

  it("returns an error when VpcId is missing", () => {
    const err = validateEc2RouteTableShape({});
    expect(err).not.toBeNull();
    expect(err).toContain("VpcId");
    expect(err).toContain("[FIX]");
  });

  it("is NOT registered in PLAN_SHAPE_VALIDATORS (R10b-04 follow-up)", () => {
    // De-registered alongside EC2_SECURITY_GROUP / EC2_NAT_GATEWAY —
    // see SG block above for full rationale.
    const err = validatePlanShape({}, RESOURCE_TYPES.EC2_ROUTE_TABLE);
    expect(err).toBeNull();
  });
});

// ── validateEc2NatGatewayShape ────────────────────────────────────────────────

describe("validateEc2NatGatewayShape", () => {
  it("returns null for a valid public NAT gateway with SubnetId and AllocationId", () => {
    expect(
      validateEc2NatGatewayShape({
        SubnetId: "subnet-0abc1234",
        AllocationId: "eipalloc-0abc1234",
      }),
    ).toBeNull();
  });

  it("returns null for a valid private NAT gateway with SubnetId only", () => {
    expect(
      validateEc2NatGatewayShape({
        SubnetId: "subnet-0abc1234",
        ConnectivityType: "private",
      }),
    ).toBeNull();
  });

  it("returns an error when SubnetId is missing", () => {
    const err = validateEc2NatGatewayShape({
      AllocationId: "eipalloc-0abc1234",
    });
    expect(err).not.toBeNull();
    expect(err).toContain("SubnetId");
    expect(err).toContain("[FIX]");
  });

  it("returns an error when public NAT gateway is missing AllocationId", () => {
    const err = validateEc2NatGatewayShape({ SubnetId: "subnet-0abc1234" });
    expect(err).not.toBeNull();
    expect(err).toContain("AllocationId");
    expect(err).toContain("[FIX]");
  });

  it("is NOT registered in PLAN_SHAPE_VALIDATORS — missing SubnetId (R10b-04 follow-up)", () => {
    // De-registered alongside EC2_SECURITY_GROUP / EC2_ROUTE_TABLE —
    // see SG block above for full rationale.
    const err = validatePlanShape(
      { AllocationId: "eipalloc-0abc1234" },
      RESOURCE_TYPES.EC2_NAT_GATEWAY,
    );
    expect(err).toBeNull();
  });

  it("is NOT registered in PLAN_SHAPE_VALIDATORS — public NAT missing AllocationId (R10b-04 follow-up)", () => {
    const err = validatePlanShape(
      { SubnetId: "subnet-0abc1234" },
      RESOURCE_TYPES.EC2_NAT_GATEWAY,
    );
    expect(err).toBeNull();
  });
});
