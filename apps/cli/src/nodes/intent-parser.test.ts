import { describe, it, expect } from "vitest";
import { ExecutionStatus, MockLlmAdapter } from "@assignee/core";
import type { AgentState } from "../services/graph.js";
import { SUPPORTED_TYPES, SUPPORTED_TYPES_HINT } from "../config/constants.js";
import { createIntentParserNode } from "./intent-parser.js";

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
    // A9 (2026-04-09): EventBridge custom event bus lifted the count to 29.
    expect(SUPPORTED_TYPES).toContain("AWS::Events::EventBus");
    expect(SUPPORTED_TYPES).toHaveLength(29);
  });
});
