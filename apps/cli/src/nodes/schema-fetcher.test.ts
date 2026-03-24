import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionStatus, SchemaFetchError } from "@assignee/core";

// Mock CloudFormationSchemaService
const mockGetSchema = vi.fn();
vi.mock("@assignee/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    CloudFormationSchemaService: vi.fn().mockImplementation(() => ({
      getSchema: mockGetSchema,
    })),
  };
});

import { schemaFetcherNode, _resetSchemaService } from "./schema-fetcher.js";
import type { AgentState } from "../services/graph.js";

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "Create an S3 bucket",
    resourceType: "AWS::S3::Bucket",
    executionStatus: ExecutionStatus.PENDING,
    resourcePattern: "",
    ...overrides,
  } as AgentState;
}

describe("schemaFetcherNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSchemaService();
  });

  it("fetches schema via CloudFormationSchemaService and adapts it", async () => {
    const rawSchema = {
      typeName: "AWS::S3::Bucket",
      description: "The AWS::S3::Bucket resource creates an S3 bucket.",
      properties: {
        BucketName: { type: "string" },
        Arn: { type: "string" },
      },
      required: [],
      readOnlyProperties: ["/properties/Arn"],
      primaryIdentifier: ["/properties/BucketName"],
      additionalProperties: false,
      handlers: { create: {}, read: {}, delete: {} },
    };

    mockGetSchema.mockResolvedValue(rawSchema);

    const result = await schemaFetcherNode(makeState());

    expect(mockGetSchema).toHaveBeenCalledWith("AWS::S3::Bucket");
    expect(result.resourceSchema).toBeDefined();
    const schema = result.resourceSchema as Record<string, unknown>;
    // Adapter should strip `handlers`
    expect(schema["handlers"]).toBeUndefined();
    // Core fields should be present
    expect(schema["typeName"]).toBe("AWS::S3::Bucket");
    expect(schema["properties"]).toEqual({
      BucketName: { type: "string" },
      Arn: { type: "string" },
    });
    expect(schema["readOnlyProperties"]).toEqual(["/properties/Arn"]);
    // Should not set FAILED status
    expect(result.executionStatus).toBeUndefined();
  });

  it("returns FAILED status when CloudFormationSchemaService throws SchemaFetchError", async () => {
    const rootCause = new Error("Access denied");
    mockGetSchema.mockRejectedValue(
      new SchemaFetchError("AWS::S3::Bucket", rootCause),
    );

    const result = await schemaFetcherNode(makeState());

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("AWS::S3::Bucket");
    expect(result.errorMessage).toContain("Access denied");
  });

  it("returns FAILED status for unexpected errors", async () => {
    mockGetSchema.mockRejectedValue(new Error("Network timeout"));

    const result = await schemaFetcherNode(makeState());

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("Network timeout");
    expect(result.errorMessage).toContain("AWS::S3::Bucket");
  });

  it("skips schema fetch when resourcePattern is set (compound path)", async () => {
    const result = await schemaFetcherNode(
      makeState({
        resourcePattern: { patternId: "serverless-api" },
      } as unknown as Partial<AgentState>),
    );

    expect(result).toEqual({});
    expect(mockGetSchema).not.toHaveBeenCalled();
  });

  it("skips schema fetch when executionStatus is not PENDING", async () => {
    const result = await schemaFetcherNode(
      makeState({ executionStatus: ExecutionStatus.FAILED }),
    );

    expect(result).toEqual({});
    expect(mockGetSchema).not.toHaveBeenCalled();
  });

  it("reuses singleton service across invocations", async () => {
    mockGetSchema.mockResolvedValue({
      typeName: "AWS::S3::Bucket",
      properties: {},
    });

    await schemaFetcherNode(makeState());
    await schemaFetcherNode(
      makeState({ resourceType: "AWS::DynamoDB::Table" }),
    );

    // getSchema called twice but CloudFormationSchemaService constructor only once
    expect(mockGetSchema).toHaveBeenCalledTimes(2);
    const { CloudFormationSchemaService: MockCtor } =
      await import("@assignee/core");
    expect(MockCtor).toHaveBeenCalledTimes(1);
  });
});
