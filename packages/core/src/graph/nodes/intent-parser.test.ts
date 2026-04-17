import { describe, it, expect } from "vitest";
import { ExecutionStatus, SUPPORTED_TYPES_ARRAY } from "../../index.js";
import { MockLlmAdapter } from "../../testing/index.js";
import type { AgentState } from "../graph-state.js";
import { createIntentParserNode } from "./intent-parser.js";

// Local aliases so the assertion lines stay byte-identical to the pre-lift
// CLI test file (Story 50-4 Wave 5 Pass D; feedback_never_weaken_tests).
const SUPPORTED_TYPES = SUPPORTED_TYPES_ARRAY;
const SUPPORTED_TYPES_HINT = `What you can create (${SUPPORTED_TYPES_ARRAY.length} resource types):

  Compute       EC2 instance, Lambda function, ECS cluster
  Storage       S3 bucket
  Databases     RDS (PostgreSQL/MySQL/MariaDB/Aurora), DynamoDB table
  Networking    VPC, Subnet, Security Group, Internet Gateway,
                NAT Gateway, Route Table, Route, Load Balancer
  API           API Gateway v2 (HTTP/WebSocket)
  Messaging     SQS queue, SNS topic
  Security      IAM role, Secrets Manager secret, SSM parameter
  Containers    ECR repository
  Observability CloudWatch alarm, CloudWatch Logs group

Examples:
  assignee plan "Create an S3 bucket for my static site"
  assignee plan "Create an EC2 t3.micro with SSH"
  assignee plan "Create a PostgreSQL database for production"`;

describe("intentParserNode", () => {
  it("identifies valid resource type (S3)", async () => {
    const mock = new MockLlmAdapter({ resourceType: "AWS::S3::Bucket" });
    const node = createIntentParserNode({ llmClient: mock });

    const state = { userIntent: "create an S3 bucket" } as AgentState;
    const result = await node(state);

    expect(result.resourceType).toBe("AWS::S3::Bucket");
    expect(result.executionStatus).toBeUndefined();
  });

  // Wave 13: the Lambda intent must NOT match any of the
  // lambda-with-exec-role pattern's keywords ("create a lambda",
  // "lambda function", "create a function", "deploy a lambda",
  // "node lambda", "python lambda", "node function", "python function",
  // "serverless function", "background worker", "scheduled lambda").
  // The pre-Wave-13 phrase "create a Lambda function for image
  // processing" matched "lambda function" → was intercepted by the
  // pattern detector and never reached the LLM classifier this test
  // is meant to exercise. Use a phrasing that bypasses every keyword:
  // "create an AWS Lambda" — substring-disjoint from all keywords (no
  // "function", different prefix from "create a lambda" because "an"
  // breaks the substring match).
  it.each([
    ["AWS::EC2::Instance", "create an EC2 t3.micro instance"],
    ["AWS::RDS::DBInstance", "create a MySQL RDS database"],
    ["AWS::Lambda::Function", "create an AWS Lambda for image processing"],
  ])("identifies %s correctly", async (resourceType, intent) => {
    const mock = new MockLlmAdapter({ resourceType });
    const node = createIntentParserNode({ llmClient: mock });

    const state = { userIntent: intent } as AgentState;
    const result = await node(state);

    expect(result.resourceType).toBe(resourceType);
    expect(result.executionStatus).toBeUndefined();
  });

  it("rejects unsupported resource types", async () => {
    const mock = new MockLlmAdapter({ resourceType: "UNSUPPORTED" });
    const node = createIntentParserNode({ llmClient: mock });

    const state = { userIntent: "create an unknown resource" } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.UNSUPPORTED_RESOURCE);
    expect(result.errorMessage).toBe(
      `Unsupported resource type. ${SUPPORTED_TYPES_HINT}.`,
    );
    expect(result.resourceType).toBeUndefined();
  });

  it("returns FAILED when LLM call fails", async () => {
    const mock = new MockLlmAdapter(undefined, "", true, "ThrottlingException");
    const node = createIntentParserNode({ llmClient: mock });

    const state = { userIntent: "create an S3 bucket" } as AgentState;
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("ThrottlingException");
  });

  it("SUPPORTED_TYPES contains all expected resource types", () => {
    expect(SUPPORTED_TYPES).toContain("AWS::S3::Bucket");
    expect(SUPPORTED_TYPES).toContain("AWS::SSM::Parameter");
    expect(SUPPORTED_TYPES).toContain("AWS::IAM::Role");
    expect(SUPPORTED_TYPES).toContain("AWS::EC2::Instance");
    expect(SUPPORTED_TYPES).toContain("AWS::RDS::DBInstance");
    expect(SUPPORTED_TYPES).toContain("AWS::Lambda::Function");
    // Story 8.1: 9 additional types added for compound architecture patterns
    expect(SUPPORTED_TYPES).toContain("AWS::EC2::VPC");
    expect(SUPPORTED_TYPES).toContain("AWS::EC2::SecurityGroup");
    expect(SUPPORTED_TYPES).toContain("AWS::DynamoDB::Table");
    expect(SUPPORTED_TYPES).toContain("AWS::SQS::Queue");
    expect(SUPPORTED_TYPES).toContain("AWS::ECS::Cluster");
    expect(SUPPORTED_TYPES).toContain("AWS::ECR::Repository");
    // A1 (2026-04-08): EFS + EFS::MountTarget lifted the count to 27.
    expect(SUPPORTED_TYPES).toContain("AWS::EFS::FileSystem");
    expect(SUPPORTED_TYPES).toContain("AWS::EFS::MountTarget");
    // A8 (2026-04-08): EventBridge Rule lifted the count to 28.
    expect(SUPPORTED_TYPES).toContain("AWS::Events::Rule");
    // A9  (2026-04-09): EventBridge custom event bus lifted the count to 29.
    expect(SUPPORTED_TYPES).toContain("AWS::Events::EventBus");
    // A10 (2026-04-09): SNS Subscription promoted to first-class, count 30.
    expect(SUPPORTED_TYPES).toContain("AWS::SNS::Subscription");
    // A11 (2026-04-09): KMS::Key first-class, count 31.
    expect(SUPPORTED_TYPES).toContain("AWS::KMS::Key");
    // A12 (2026-04-09): Events::Connection first-class, count 32.
    expect(SUPPORTED_TYPES).toContain("AWS::Events::Connection");
    // A13 (2026-04-09): Events::ApiDestination first-class, count 33.
    expect(SUPPORTED_TYPES).toContain("AWS::Events::ApiDestination");
    // A14 (2026-04-09): CloudFront::Distribution first-class, count 34.
    expect(SUPPORTED_TYPES).toContain("AWS::CloudFront::Distribution");
    // (f) 2026-04-09 Task 4b: CloudFront OriginAccessControl + S3 BucketPolicy
    // first-class to unblock the static-website compound migration, count 36.
    expect(SUPPORTED_TYPES).toContain("AWS::CloudFront::OriginAccessControl");
    expect(SUPPORTED_TYPES).toContain("AWS::S3::BucketPolicy");
    expect(SUPPORTED_TYPES).toHaveLength(37);
  });
});
