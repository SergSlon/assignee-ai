/**
 * Tests for the compound-dispatcher node (Story 8.2).
 * Verifies single-resource pass-through and compound provisioning setup.
 */

import { describe, it, expect } from "vitest";
import { compoundDispatcherNode } from "./compound-dispatcher.js";
import { ExecutionStatus, ExecutionMode } from "../../index.js";
import type { AgentState } from "../graph-state.js";
import type { ArchitecturePattern } from "../../index.js";

/** Minimal mock AgentState for compound-dispatcher tests */
function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "create a serverless api",
    runId: "test-run-id",
    executionMode: ExecutionMode.APPLY,
    resourceType: "",
    executionStatus: ExecutionStatus.PENDING,
    preflightPassed: false,
    preflightErrors: [],
    preflightMode: "local",
    messages: [],
    ...overrides,
  } as AgentState;
}

/** A 3-resource serverless-api pattern for testing */
const mockPattern: ArchitecturePattern = {
  patternId: "serverless-api",
  displayName: "Serverless API",
  keywords: ["serverless api"],
  resourceList: [
    {
      resourceId: "lambda-execution-role",
      resourceType: "AWS::IAM::Role",
      displayName: "Lambda Execution Role",
    },
    {
      resourceId: "lambda-fn",
      resourceType: "AWS::Lambda::Function",
      displayName: "Lambda Function",
    },
    {
      resourceId: "api-gateway",
      resourceType: "AWS::ApiGatewayV2::Api",
      displayName: "API Gateway",
    },
  ],
  dependencyOrder: [["lambda-execution-role"], ["lambda-fn", "api-gateway"]],
  defaultOptions: {
    "lambda-execution-role": { RoleName: "my-lambda-role" },
    "lambda-fn": { FunctionName: "my-function", Runtime: "nodejs20.x" },
    "api-gateway": { Name: "my-api", ProtocolType: "HTTP" },
  },
};

describe("compoundDispatcherNode — single-resource path", () => {
  it("returns {} when resourcePattern is not set", async () => {
    const state = makeState({ resourcePattern: undefined });
    const result = await compoundDispatcherNode(state);
    expect(result).toEqual({});
  });

  it("does not set resourceQueue when resourcePattern is absent", async () => {
    const state = makeState({ resourcePattern: undefined });
    const result = await compoundDispatcherNode(state);
    expect(result.resourceQueue).toBeUndefined();
    expect(result.currentResourceIndex).toBeUndefined();
    expect(result.completedResources).toBeUndefined();
  });
});

describe("compoundDispatcherNode — compound path", () => {
  it("flattens dependencyOrder into resourceQueue preserving group order", async () => {
    const state = makeState({ resourcePattern: mockPattern });
    const result = await compoundDispatcherNode(state);

    // dependencyOrder: [["lambda-execution-role"], ["lambda-fn", "api-gateway"]]
    // flattened: lambda-execution-role, lambda-fn, api-gateway
    expect(result.resourceQueue).toHaveLength(3);
    expect(result.resourceQueue?.[0]?.resourceId).toBe("lambda-execution-role");
    expect(result.resourceQueue?.[1]?.resourceId).toBe("lambda-fn");
    expect(result.resourceQueue?.[2]?.resourceId).toBe("api-gateway");
  });

  it("sets currentResourceIndex to 0", async () => {
    const state = makeState({ resourcePattern: mockPattern });
    const result = await compoundDispatcherNode(state);
    expect(result.currentResourceIndex).toBe(0);
  });

  it("initializes completedResources as empty array", async () => {
    const state = makeState({ resourcePattern: mockPattern });
    const result = await compoundDispatcherNode(state);
    expect(result.completedResources).toEqual([]);
  });

  it("sets resourceType to the first resource's type", async () => {
    const state = makeState({ resourcePattern: mockPattern });
    const result = await compoundDispatcherNode(state);
    expect(result.resourceType).toBe("AWS::IAM::Role");
  });

  it("clears desiredState (plan_generator will generate from defaultOptions)", async () => {
    const state = makeState({
      resourcePattern: mockPattern,
      desiredState: { old: "value" },
    });
    const result = await compoundDispatcherNode(state);
    expect(result.desiredState).toBeUndefined();
  });

  it("handles pattern with single resource in dependencyOrder", async () => {
    const singlePattern: ArchitecturePattern = {
      ...mockPattern,
      resourceList: [
        {
          resourceId: "my-bucket",
          resourceType: "AWS::S3::Bucket",
          displayName: "My Bucket",
        },
      ],
      dependencyOrder: [["my-bucket"]],
      defaultOptions: { "my-bucket": { BucketName: "my-bucket" } },
    };
    const state = makeState({ resourcePattern: singlePattern });
    const result = await compoundDispatcherNode(state);

    expect(result.resourceQueue).toHaveLength(1);
    expect(result.currentResourceIndex).toBe(0);
    expect(result.resourceType).toBe("AWS::S3::Bucket");
  });

  it("returns empty resourceQueue for degenerate pattern with no matching resourceIds", async () => {
    const degeneratePattern: ArchitecturePattern = {
      ...mockPattern,
      resourceList: [],
      dependencyOrder: [["non-existent-id"]],
    };
    const state = makeState({ resourcePattern: degeneratePattern });
    const result = await compoundDispatcherNode(state);

    expect(result.resourceQueue).toEqual([]);
    // Degenerate case: no currentResourceIndex or resourceType set
    expect(result.currentResourceIndex).toBeUndefined();
  });
});
