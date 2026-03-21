import { describe, it, expect } from "vitest";
import { ExecutionStatus, MockLlmAdapter } from "@assignee/core";
import { createPlanGeneratorNode } from "./plan-generator.js";
import type { AgentState } from "../services/graph.js";

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    userIntent: "Create an S3 bucket named my-test-bucket",
    runId: "run-test-123",
    executionStatus: ExecutionStatus.PENDING,
    executionMode: "plan",
    resourceType: "AWS::S3::Bucket",
    resourceSchema: {
      properties: {
        BucketName: { type: "string" },
        Tags: { type: "array" },
      },
      required: ["BucketName"],
    },
    desiredState: undefined,
    estimatedMonthlyCost: undefined,
    requestToken: undefined,
    resourceArn: undefined,
    errorMessage: undefined,
    startedAt: undefined,
    messages: [],
    preflightPassed: false,
    preflightErrors: [],
    preflightMode: "local",
    ...overrides,
  } as unknown as Parameters<ReturnType<typeof createPlanGeneratorNode>>[0];
}

describe("planGeneratorNode", () => {
  it("populates desiredState from LLM response", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "my-test-bucket" }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    expect(result.desiredState).toEqual({ BucketName: "my-test-bucket" });
    expect(result.executionStatus).toBeUndefined(); // no failure
  });

  it("strips hallucinated fields not in schema", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "my-bucket", HallucinatedField: "bad" }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    expect(result.desiredState).toEqual({ BucketName: "my-bucket" });
    expect(
      (result.desiredState as Record<string, unknown>)?.["HallucinatedField"],
    ).toBeUndefined();
  });

  it("returns FAILED when LLM returns invalid JSON", async () => {
    const mock = new MockLlmAdapter(undefined, "not json at all");
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("invalid JSON");
  });

  it("returns FAILED when resourceSchema is missing", async () => {
    const mock = new MockLlmAdapter(undefined, "{}");
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(makeState({ resourceSchema: undefined }));

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("schema is missing");
  });

  it("skips processing when executionStatus is already FAILED", async () => {
    // mock that would fail if called — ensures no LLM call is made
    const mock = new MockLlmAdapter(
      undefined,
      "",
      true,
      "should not be called",
    );
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(
      makeState({ executionStatus: ExecutionStatus.FAILED }),
    );

    expect(result).toEqual({});
  });

  it("handles LLM errors gracefully", async () => {
    const mock = new MockLlmAdapter(undefined, "", true, "ThrottlingException");
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("ThrottlingException");
  });

  it("returns FAILED when LLM returns empty text (null-check)", async () => {
    const mock = new MockLlmAdapter(undefined, "");
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("Plan generation failed");
  });

  it("strips markdown fences from LLM response", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      '```json\n{"BucketName":"clean-bucket"}\n```',
    );
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    expect(result.desiredState).toEqual({ BucketName: "clean-bucket" });
  });

  it("unwraps CloudFormation Resources section format if LLM generates it", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: { BucketName: "my-test-bucket" },
        },
      }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(makeState());

    expect(result.desiredState).toEqual({ BucketName: "my-test-bucket" });
  });

  it("includes Lambda runtime constraints and role omission rule in prompt for Lambda resource type", async () => {
    let capturedPrompt = "";
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({
        FunctionName: "my-fn",
        Runtime: "nodejs22.x",
        Handler: "index.handler",
      }),
    );

    // Spy on generateText to capture the prompt
    const originalGenerateText = mock.generateText.bind(mock);
    mock.generateText = async (prompt: string) => {
      capturedPrompt = prompt;
      return originalGenerateText(prompt);
    };

    const node = createPlanGeneratorNode({ llmClient: mock });
    await node(
      makeState({
        resourceType: "AWS::Lambda::Function",
        userIntent: "Create a lambda function",
        resourceSchema: {
          properties: {
            FunctionName: { type: "string" },
            Runtime: { type: "string" },
            Handler: { type: "string" },
            Role: { type: "string" },
          },
          required: ["FunctionName", "Runtime", "Handler", "Role"],
        },
      }),
    );

    expect(capturedPrompt).toContain("nodejs22.x");
    expect(capturedPrompt).toContain("deprecated");
    expect(capturedPrompt).toContain("OMIT the Role property");
  });

  it("does not inject resource hints for non-Lambda resource types", async () => {
    let capturedPrompt = "";
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "my-bucket" }),
    );

    const originalGenerateText = mock.generateText.bind(mock);
    mock.generateText = async (prompt: string) => {
      capturedPrompt = prompt;
      return originalGenerateText(prompt);
    };

    const node = createPlanGeneratorNode({ llmClient: mock });
    await node(makeState());

    expect(capturedPrompt).not.toContain("RESOURCE-SPECIFIC RULES");
  });

  it("reads schema from uppercase Properties key as fallback", async () => {
    const mock = new MockLlmAdapter(
      undefined,
      JSON.stringify({ BucketName: "my-bucket", HallucinatedField: "bad" }),
    );
    const node = createPlanGeneratorNode({ llmClient: mock });

    const result = await node(
      makeState({
        resourceSchema: {
          Properties: {
            BucketName: { type: "string" },
            Tags: { type: "array" },
          },
          required: ["BucketName"],
        },
      }),
    );

    expect(result.desiredState).toEqual({ BucketName: "my-bucket" });
  });
});
