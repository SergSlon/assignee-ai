import { describe, it, expect, vi } from "vitest";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";

// Mock cloudcontrol-client so createGraph() doesn't throw on missing env vars
vi.mock("../services/cloudcontrol-client.js", () => ({
  createCloudControlClient: vi.fn(() => ({ send: vi.fn() })),
}));

// Mock AI SDK (used by intent-parser and plan-generator)
vi.mock("ai", () => ({
  generateText: vi
    .fn()
    // First call: intent-parser (uses output.resourceType)
    .mockResolvedValueOnce({
      output: { resourceType: "AWS::S3::Bucket" },
      text: "",
    })
    // Second call: plan-generator (uses text)
    .mockResolvedValueOnce({
      text: '{"BucketName":"test-bucket"}',
      output: undefined,
    }),
  Output: { object: vi.fn() },
}));

vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: vi.fn(() => vi.fn()),
}));

// Mock LlmAdapter so graph.ts doesn't resolve real providers.
// Return Result tuples matching LlmPort interface.
vi.mock("./llm-adapter.js", () => ({
  LlmAdapter: vi.fn().mockImplementation(() => ({
    generateStructured: vi
      .fn()
      .mockResolvedValue([null, { resourceType: "AWS::S3::Bucket" }]),
    generateText: vi
      .fn()
      .mockResolvedValue([null, '{"BucketName":"test-bucket"}']),
  })),
}));

// Mock the nodes that have external dependencies or side-effects
vi.mock("../nodes/schema-fetcher.js", () => ({
  schemaFetcherNode: vi.fn().mockResolvedValue({
    resourceSchema: {
      properties: { BucketName: { type: "string" } },
      required: ["BucketName"],
    },
  }),
}));

vi.mock("../nodes/preflight-guard.js", () => ({
  preflightGuardNode: vi.fn().mockResolvedValue({
    preflightPassed: true,
    estimatedMonthlyCost: "N/A",
  }),
}));

vi.mock("../nodes/human-approval.js", () => ({
  humanApprovalNode: vi.fn().mockResolvedValue({}),
}));

vi.mock("../nodes/result-formatter.js", () => ({
  resultFormatterNode: vi.fn().mockResolvedValue({}),
}));

import { createGraph } from "./graph.js";

describe("createGraph", () => {
  it("graph compiles and runs in plan mode without hitting resource_provisioner", async () => {
    const graph = createGraph();

    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket named test-bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "test-thread-plan" } },
    );

    // Plan mode routes preflight → result_formatter (skips human_approval/resource_provisioner)
    expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
    expect(result.preflightPassed).toBe(true);
  });
});
