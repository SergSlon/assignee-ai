import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionStatus, SchemaFetchError } from "../../index.js";

// createSchemaFetcherNode accepts a CloudFormationSchemaService instance —
// we pass a plain object stub; no class-level vi.mock() required.
const mockGetSchema = vi.fn();

import { createSchemaFetcherNode } from "./schema-fetcher.js";
import type { CloudFormationSchemaService } from "../../index.js";
import type { AgentState } from "../graph-state.js";

/** Build a stub CloudFormationSchemaService with the mock getSchema impl. */
function makeService(): CloudFormationSchemaService {
  return { getSchema: mockGetSchema } as unknown as CloudFormationSchemaService;
}

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "Create an S3 bucket",
    resourceType: "AWS::S3::Bucket",
    executionStatus: ExecutionStatus.PENDING,
    resourcePattern: "",
    ...overrides,
  } as AgentState;
}

describe("createSchemaFetcherNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    const node = createSchemaFetcherNode(makeService());
    const result = await node(makeState());

    expect(mockGetSchema).toHaveBeenCalledWith("AWS::S3::Bucket");
    // Tier C: dropped redundant toBeDefined() — subsequent property
    // accesses fail naturally on undefined
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

    const node = createSchemaFetcherNode(makeService());
    const result = await node(makeState());

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("AWS::S3::Bucket");
    expect(result.errorMessage).toContain("Access denied");
  });

  it("returns FAILED status for unexpected errors", async () => {
    mockGetSchema.mockRejectedValue(new Error("Network timeout"));

    const node = createSchemaFetcherNode(makeService());
    const result = await node(makeState());

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("Network timeout");
    expect(result.errorMessage).toContain("AWS::S3::Bucket");
  });

  it("skips schema fetch when resourcePattern is set (compound path)", async () => {
    const node = createSchemaFetcherNode(makeService());
    const result = await node(
      makeState({
        resourcePattern: { patternId: "serverless-api" },
      } as unknown as Partial<AgentState>),
    );

    expect(result).toEqual({});
    expect(mockGetSchema).not.toHaveBeenCalled();
  });

  it("skips schema fetch when executionStatus is not PENDING", async () => {
    const node = createSchemaFetcherNode(makeService());
    const result = await node(
      makeState({ executionStatus: ExecutionStatus.FAILED }),
    );

    expect(result).toEqual({});
    expect(mockGetSchema).not.toHaveBeenCalled();
  });

  it("each factory call produces an independent node bound to its own service", async () => {
    // Two service stubs with different mockGetSchema implementations
    const mockGetSchemaA = vi.fn().mockResolvedValue({
      typeName: "AWS::S3::Bucket",
      properties: {},
    });
    const mockGetSchemaB = vi.fn().mockResolvedValue({
      typeName: "AWS::DynamoDB::Table",
      properties: {},
    });

    const serviceA = {
      getSchema: mockGetSchemaA,
    } as unknown as CloudFormationSchemaService;
    const serviceB = {
      getSchema: mockGetSchemaB,
    } as unknown as CloudFormationSchemaService;

    const nodeA = createSchemaFetcherNode(serviceA);
    const nodeB = createSchemaFetcherNode(serviceB);

    await nodeA(makeState({ resourceType: "AWS::S3::Bucket" }));
    await nodeB(makeState({ resourceType: "AWS::DynamoDB::Table" }));

    // Each node called only its own service — no cross-contamination
    expect(mockGetSchemaA).toHaveBeenCalledOnce();
    expect(mockGetSchemaA).toHaveBeenCalledWith("AWS::S3::Bucket");
    expect(mockGetSchemaB).toHaveBeenCalledOnce();
    expect(mockGetSchemaB).toHaveBeenCalledWith("AWS::DynamoDB::Table");
    // Cross-contamination guard: B's schema not requested from A and vice versa
    expect(mockGetSchemaA).not.toHaveBeenCalledWith("AWS::DynamoDB::Table");
    expect(mockGetSchemaB).not.toHaveBeenCalledWith("AWS::S3::Bucket");
  });

  it("reuses the injected service across multiple invocations of the same node", async () => {
    mockGetSchema.mockResolvedValue({
      typeName: "AWS::S3::Bucket",
      properties: {},
    });

    const service = makeService();
    const node = createSchemaFetcherNode(service);

    await node(makeState());
    await node(makeState({ resourceType: "AWS::DynamoDB::Table" }));

    // getSchema called twice on the same injected service instance
    expect(mockGetSchema).toHaveBeenCalledTimes(2);
  });
});
