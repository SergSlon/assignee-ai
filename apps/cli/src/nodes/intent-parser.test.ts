import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionStatus } from "@assignee/core";
import type { AgentState } from "../services/graph.js";
import { SUPPORTED_TYPES, SUPPORTED_TYPES_HINT } from "../config/constants.js";

// Automock the ai module
vi.mock("ai");

// Mock bedrock to prevent initialization side-effects
vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: vi.fn(() => vi.fn()),
}));

import { intentParserNode } from "./intent-parser.js";
import { generateText } from "ai";

describe("intentParserNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("identifies valid resource type (S3)", async () => {
    vi.mocked(generateText).mockResolvedValue({
      output: { resourceType: "AWS::S3::Bucket" },
    } as any);

    const state = { userIntent: "create an S3 bucket" } as AgentState;
    const result = await intentParserNode(state);

    expect(result.resourceType).toBe("AWS::S3::Bucket");
    expect(result.executionStatus).toBeUndefined();
  });

  it.each([
    ["AWS::EC2::Instance", "create an EC2 t3.micro instance"],
    ["AWS::RDS::DBInstance", "create a MySQL RDS database"],
    ["AWS::Lambda::Function", "create a Lambda function for image processing"],
  ])("identifies %s correctly", async (resourceType, intent) => {
    vi.mocked(generateText).mockResolvedValue({
      output: { resourceType },
    } as any);

    const state = { userIntent: intent } as AgentState;
    const result = await intentParserNode(state);

    expect(result.resourceType).toBe(resourceType);
    expect(result.executionStatus).toBeUndefined();
  });

  it("rejects unsupported resource types", async () => {
    vi.mocked(generateText).mockResolvedValue({
      output: { resourceType: "UNSUPPORTED" },
    } as any);

    const state = { userIntent: "create an unknown resource" } as AgentState;
    const result = await intentParserNode(state);

    expect(result.executionStatus).toBe(ExecutionStatus.UNSUPPORTED_RESOURCE);
    expect(result.errorMessage).toBe(
      `Unsupported resource type. ${SUPPORTED_TYPES_HINT}.`,
    );
    expect(result.resourceType).toBeUndefined();
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
    expect(SUPPORTED_TYPES).toHaveLength(15);
  });
});
