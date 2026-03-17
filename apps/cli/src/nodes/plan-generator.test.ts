import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionStatus } from "@assignee/core";

// Mock the ai SDK before importing the node
vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: vi.fn(() => vi.fn()),
}));

const { generateText } = await import("ai");
const { planGeneratorNode } = await import("./plan-generator.js");

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
  } as unknown as Parameters<typeof planGeneratorNode>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("planGeneratorNode", () => {
  it("populates desiredState from Bedrock response", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      text: JSON.stringify({ BucketName: "my-test-bucket" }),
    } as Awaited<ReturnType<typeof generateText>>);

    const result = await planGeneratorNode(makeState());

    expect(result.desiredState).toEqual({ BucketName: "my-test-bucket" });
    expect(result.executionStatus).toBeUndefined(); // no failure
  });

  it("strips hallucinated fields not in schema", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      text: JSON.stringify({
        BucketName: "my-bucket",
        HallucinatedField: "bad",
      }),
    } as Awaited<ReturnType<typeof generateText>>);

    const result = await planGeneratorNode(makeState());

    expect(result.desiredState).toEqual({ BucketName: "my-bucket" });
    expect(
      (result.desiredState as Record<string, unknown>)?.["HallucinatedField"],
    ).toBeUndefined();
  });

  it("returns FAILED when Bedrock returns invalid JSON", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "not json at all",
    } as Awaited<ReturnType<typeof generateText>>);

    const result = await planGeneratorNode(makeState());

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("invalid JSON");
  });

  it("returns FAILED when resourceSchema is missing", async () => {
    const result = await planGeneratorNode(
      makeState({ resourceSchema: undefined }),
    );

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("schema is missing");
  });

  it("skips processing when executionStatus is already FAILED", async () => {
    const result = await planGeneratorNode(
      makeState({ executionStatus: ExecutionStatus.FAILED }),
    );

    expect(generateText).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it("handles Bedrock errors gracefully", async () => {
    vi.mocked(generateText).mockRejectedValueOnce(
      new Error("ThrottlingException"),
    );

    const result = await planGeneratorNode(makeState());

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("ThrottlingException");
  });

  it("strips markdown fences from Bedrock response", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      text: '```json\n{"BucketName":"clean-bucket"}\n```',
    } as Awaited<ReturnType<typeof generateText>>);

    const result = await planGeneratorNode(makeState());

    expect(result.desiredState).toEqual({ BucketName: "clean-bucket" });
  });

  it("unwraps CloudFormation Resources section format if LLM generates it", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      text: JSON.stringify({
        MyBucket: {
          Type: "AWS::S3::Bucket",
          Properties: { BucketName: "my-test-bucket" },
        },
      }),
    } as Awaited<ReturnType<typeof generateText>>);

    const result = await planGeneratorNode(makeState());

    expect(result.desiredState).toEqual({ BucketName: "my-test-bucket" });
  });

  it("includes Lambda runtime constraints and role omission rule in prompt for Lambda resource type", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      text: JSON.stringify({
        FunctionName: "my-fn",
        Runtime: "nodejs22.x",
        Handler: "index.handler",
      }),
    } as Awaited<ReturnType<typeof generateText>>);

    await planGeneratorNode(
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

    const call = vi.mocked(generateText).mock.calls[0]?.[0];
    const content = (call?.messages?.[0]?.content ?? "") as string;
    expect(content).toContain("nodejs22.x");
    expect(content).toContain("deprecated");
    expect(content).toContain("OMIT the Role property");
  });

  it("does not inject resource hints for non-Lambda resource types", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      text: JSON.stringify({ BucketName: "my-bucket" }),
    } as Awaited<ReturnType<typeof generateText>>);

    await planGeneratorNode(makeState());

    const call = vi.mocked(generateText).mock.calls[0]?.[0];
    const content = (call?.messages?.[0]?.content ?? "") as string;
    expect(content).not.toContain("RESOURCE-SPECIFIC RULES");
  });

  it("reads schema from uppercase Properties key as fallback", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      text: JSON.stringify({
        BucketName: "my-bucket",
        HallucinatedField: "bad",
      }),
    } as Awaited<ReturnType<typeof generateText>>);

    const result = await planGeneratorNode(
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
