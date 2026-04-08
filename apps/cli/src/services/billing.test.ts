/**
 * Tests for the billing data service (Story 19.7).
 *
 * Covers:
 * - fetchBillingData with mock MCP tools returns correct cost data
 * - fetchBillingData with no MCP tools falls back to provision log memory
 * - fetchBillingData with failing MCP tools falls back gracefully
 * - getCostSavingsEstimate returns formatted savings string
 * - getCostSavingsEstimate returns "N/A" when no data available
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchBillingData, getCostSavingsEstimate } from "./billing.js";
import {
  McpMocks,
  createMockTool,
  createFailingMockTool,
  createBillingMockTool,
} from "../test-fixtures/mcp-mock-responses.js";
import { ToolName } from "../constants/tools.js";
import type { ManagedResource } from "./list-resources.js";

// Mock the memory service
vi.mock("./memory.js", () => ({
  defaultMemoryService: {
    readProvisions: vi.fn().mockResolvedValue([]),
  },
}));

// Import the mocked memory service for test manipulation
import { defaultMemoryService } from "./memory.js";

const mockReadProvisions = vi.mocked(defaultMemoryService.readProvisions);

const sampleResource: ManagedResource = {
  resourceType: "AWS::S3::Bucket",
  arn: "arn:aws:s3:::my-assignee-bucket-20260322",
  region: "us-east-1",
  createdDate: "2026-03-22",
  estimatedMonthlyCost: "N/A",
};

const lambdaResource: ManagedResource = {
  resourceType: "AWS::Lambda::Function",
  arn: "arn:aws:lambda:us-east-1:123456789012:function:my-function",
  region: "us-east-1",
  createdDate: "2026-03-22",
  estimatedMonthlyCost: "N/A",
};

describe("fetchBillingData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadProvisions.mockResolvedValue([]);
  });

  it("returns cost data from MCP tools when available", async () => {
    const tools = [
      createBillingMockTool(McpMocks.billing.s3BucketCost.success),
    ];

    const result = await fetchBillingData([sampleResource], tools);

    // Tier C: dropped redundant toBeDefined() — get returns undefined
    // for missing keys; the toBe() asserts fail naturally with `!`
    expect(result.size).toBe(1);
    const entry = result.get(sampleResource.arn)!;
    expect(entry.actualMonthlyCost).toBe("$0.02/month");
    expect(entry.currency).toBe("USD");
  });

  it("returns multiple resources from MCP tools", async () => {
    const tools = [
      createBillingMockTool(McpMocks.billing.multiResourceCost.success),
    ];

    const result = await fetchBillingData(
      [sampleResource, lambdaResource],
      tools,
    );

    expect(result.size).toBe(2);
    expect(result.get(sampleResource.arn)!.actualMonthlyCost).toBe(
      "$0.02/month",
    );
    expect(result.get(lambdaResource.arn)!.actualMonthlyCost).toBe(
      "$1.47/month",
    );
  });

  it("falls back to provision log when no MCP tools provided", async () => {
    mockReadProvisions.mockResolvedValue([
      {
        runId: "00000000-0000-0000-0000-000000000001",
        resourceType: "AWS::S3::Bucket",
        resourceArn: sampleResource.arn,
        region: "us-east-1",
        desiredStateHash: "abc123",
        estimatedMonthlyCost: "$0.05/month",
        timestamp: "2026-03-22T00:00:00.000Z",
      },
    ]);

    const result = await fetchBillingData([sampleResource]);

    // Tier C: dropped redundant toBeDefined()
    expect(result.size).toBe(1);
    const entry = result.get(sampleResource.arn)!;
    expect(entry.actualMonthlyCost).toBe("$0.05/month");
    expect(entry.forecastedMonthlyCost).toBe("$0.05/month");
  });

  it("falls back to provision log when MCP tools fail", async () => {
    const failingTool = createFailingMockTool(
      ToolName.GET_COST_AND_USAGE,
      new Error("MCP server unavailable"),
    );

    mockReadProvisions.mockResolvedValue([
      {
        runId: "00000000-0000-0000-0000-000000000002",
        resourceType: "AWS::S3::Bucket",
        resourceArn: sampleResource.arn,
        region: "us-east-1",
        desiredStateHash: "abc123",
        estimatedMonthlyCost: "$0.05/month",
        timestamp: "2026-03-22T00:00:00.000Z",
      },
    ]);

    const result = await fetchBillingData([sampleResource], [failingTool]);

    expect(result.size).toBe(1);
    expect(result.get(sampleResource.arn)!.actualMonthlyCost).toBe(
      "$0.05/month",
    );
  });

  it("falls back to provision log when MCP returns empty cost data", async () => {
    const tools = [createBillingMockTool(McpMocks.billing.noCostData.success)];

    mockReadProvisions.mockResolvedValue([
      {
        runId: "00000000-0000-0000-0000-000000000003",
        resourceType: "AWS::S3::Bucket",
        resourceArn: sampleResource.arn,
        region: "us-east-1",
        desiredStateHash: "abc123",
        estimatedMonthlyCost: "$0.05/month",
        timestamp: "2026-03-22T00:00:00.000Z",
      },
    ]);

    const result = await fetchBillingData([sampleResource], tools);

    // Empty MCP result -> falls through to provision log
    expect(result.size).toBe(1);
    expect(result.get(sampleResource.arn)!.actualMonthlyCost).toBe(
      "$0.05/month",
    );
  });

  it("returns empty map when both MCP and provision log have no data", async () => {
    const result = await fetchBillingData([sampleResource]);

    expect(result.size).toBe(0);
  });

  it("returns empty map when MCP tools list is empty", async () => {
    const result = await fetchBillingData([sampleResource], []);

    expect(result.size).toBe(0);
  });

  it("returns empty map when no billing tool in tools list", async () => {
    // Provide a non-billing tool
    const tools = [
      createMockTool(ToolName.GET_PRICING, McpMocks.pricing.s3Storage.success),
    ];

    const result = await fetchBillingData([sampleResource], tools);

    // No billing tool found -> falls through to provision log -> empty
    expect(result.size).toBe(0);
  });
});

describe("getCostSavingsEstimate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadProvisions.mockResolvedValue([]);
  });

  it("returns formatted savings string from MCP data", async () => {
    const tools = [
      createBillingMockTool(McpMocks.billing.s3BucketCost.success),
    ];

    const result = await getCostSavingsEstimate(sampleResource.arn, tools);

    expect(result).toBe("$0.02/month saved");
  });

  it("returns formatted savings from provision log fallback", async () => {
    mockReadProvisions.mockResolvedValue([
      {
        runId: "00000000-0000-0000-0000-000000000004",
        resourceType: "AWS::S3::Bucket",
        resourceArn: sampleResource.arn,
        region: "us-east-1",
        desiredStateHash: "abc123",
        estimatedMonthlyCost: "$2.50/month",
        timestamp: "2026-03-22T00:00:00.000Z",
      },
    ]);

    const result = await getCostSavingsEstimate(sampleResource.arn);

    expect(result).toBe("$2.50/month saved");
  });

  it('returns "N/A" when no data available', async () => {
    const result = await getCostSavingsEstimate(sampleResource.arn);

    expect(result).toBe("N/A");
  });

  it('returns "N/A" when MCP tools fail', async () => {
    const failingTool = createFailingMockTool(
      ToolName.GET_COST_AND_USAGE,
      new Error("Server down"),
    );

    const result = await getCostSavingsEstimate(sampleResource.arn, [
      failingTool,
    ]);

    expect(result).toBe("N/A");
  });
});
