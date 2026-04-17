import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionMode, ExecutionStatus } from "../index.js";

// NOTE: Plain functions/classes survive vitest's mockReset:true. vi.fn-based
// mocks have their default behavior re-installed in beforeEach.
//
// Story 50-4 Wave 5 Pass I: moved from `apps/cli/src/services/graph.test.ts`.
// Assertions unchanged — only mock-target paths + test-side import paths
// point at core-internal modules (createGraph lives in core now).

// Mock cloudcontrol-client so createGraph() doesn't throw on missing env vars
vi.mock("../services/cloudcontrol-client.js", () => ({
  createCloudControlClient: () => ({ send: () => undefined }),
}));

// Mock AI SDK (used by intent-parser and plan-generator)
vi.mock("ai", () => ({
  generateText: vi.fn(),
  Output: { object: vi.fn() },
}));

vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: () => () => undefined,
}));

// Mock LlmAdapter so create-graph.ts doesn't resolve real providers.
// Return Result tuples matching LlmPort interface.
vi.mock("../llm/adapter.js", () => ({
  LlmAdapter: vi.fn(),
}));

// Mock the nodes that have external dependencies or side-effects
vi.mock("./nodes/schema-fetcher.js", () => ({
  schemaFetcherNode: vi.fn(),
}));

vi.mock("./nodes/preflight-guard.js", () => ({
  preflightGuardNode: vi.fn(),
}));

vi.mock("./nodes/human-approval.js", () => ({
  humanApprovalNode: vi.fn(),
}));

vi.mock("./nodes/result-formatter.js", () => ({
  resultFormatterNode: vi.fn(),
}));

import { createGraph } from "./create-graph.js";
import { LlmAdapter } from "../llm/adapter.js";
import { schemaFetcherNode } from "./nodes/schema-fetcher.js";
import { preflightGuardNode } from "./nodes/preflight-guard.js";
import { humanApprovalNode } from "./nodes/human-approval.js";
import { resultFormatterNode } from "./nodes/result-formatter.js";

beforeEach(() => {
  vi.mocked(LlmAdapter).mockImplementation(
    () =>
      ({
        generateStructured: vi
          .fn()
          .mockResolvedValue([null, { resourceType: "AWS::S3::Bucket" }]),
        generateText: vi
          .fn()
          .mockResolvedValue([null, '{"BucketName":"test-bucket"}']),
      }) as unknown as InstanceType<typeof LlmAdapter>,
  );
  vi.mocked(schemaFetcherNode).mockResolvedValue({
    resourceSchema: {
      properties: { BucketName: { type: "string" } },
      required: ["BucketName"],
    },
  } as never);
  vi.mocked(preflightGuardNode).mockResolvedValue({
    preflightPassed: true,
    estimatedMonthlyCost: "N/A",
  } as never);
  vi.mocked(humanApprovalNode).mockResolvedValue({} as never);
  vi.mocked(resultFormatterNode).mockResolvedValue({} as never);
});

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
