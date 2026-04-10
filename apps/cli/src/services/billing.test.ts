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
import {
  fetchBillingData,
  getCostSavingsEstimate,
  extractResultsByTime,
  arnToServiceSlug,
} from "./billing.js";
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
      ToolName.COST_EXPLORER,
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
      ToolName.COST_EXPLORER,
      new Error("Server down"),
    );

    const result = await getCostSavingsEstimate(sampleResource.arn, [
      failingTool,
    ]);

    expect(result).toBe("N/A");
  });
});

// ────────────────────────────────────────────────────────────────────
// extractResultsByTime — internal function direct tests
// ────────────────────────────────────────────────────────────────────

describe("extractResultsByTime", () => {
  it("returns [] for null input", () => {
    expect(extractResultsByTime(null)).toEqual([]);
  });

  it("returns [] for undefined input", () => {
    expect(extractResultsByTime(undefined)).toEqual([]);
  });

  it("returns [] for non-object input (string)", () => {
    expect(extractResultsByTime("not an object")).toEqual([]);
  });

  it("returns [] for non-object input (number)", () => {
    expect(extractResultsByTime(42)).toEqual([]);
  });

  it("returns [] when data.preview is missing", () => {
    expect(extractResultsByTime({ status: "success", data: {} })).toEqual([]);
  });

  it("returns [] when data itself is missing", () => {
    expect(extractResultsByTime({ status: "success" })).toEqual([]);
  });

  it("returns [] when preview contains malformed JSON in value", () => {
    const response = {
      status: "success",
      data: {
        preview: [{ key: "ResultsByTime", value: "not-valid-json{{{" }],
      },
    };
    expect(extractResultsByTime(response)).toEqual([]);
  });

  it("parses valid session-based response with ResultsByTime", () => {
    const resultsByTime = [
      {
        TimePeriod: { Start: "2026-04-01", End: "2026-05-01" },
        Groups: [
          {
            Keys: ["Amazon Simple Storage Service"],
            Metrics: {
              UnblendedCost: { Amount: "10.00", Unit: "USD" },
            },
          },
        ],
      },
    ];
    const response = {
      status: "success",
      data: {
        preview: [
          { key: "ResultsByTime", value: JSON.stringify(resultsByTime) },
        ],
      },
    };
    const result = extractResultsByTime(response);
    expect(result).toEqual(resultsByTime);
  });

  it("unwraps MCP text wrapper { type: 'text', text: '...' } and parses correctly", () => {
    const resultsByTime = [
      {
        TimePeriod: { Start: "2026-04-01", End: "2026-05-01" },
        Groups: [
          {
            Keys: ["AWS Lambda"],
            Metrics: {
              UnblendedCost: { Amount: "1.47", Unit: "USD" },
            },
          },
        ],
      },
    ];
    const innerPayload = {
      status: "success",
      data: {
        preview: [
          { key: "ResultsByTime", value: JSON.stringify(resultsByTime) },
        ],
      },
    };
    const mcpWrapped = { type: "text", text: JSON.stringify(innerPayload) };
    const result = extractResultsByTime(mcpWrapped);
    expect(result).toEqual(resultsByTime);
  });

  it("returns [] when preview value parses to non-array", () => {
    const response = {
      status: "success",
      data: {
        preview: [
          { key: "ResultsByTime", value: JSON.stringify({ notAnArray: true }) },
        ],
      },
    };
    expect(extractResultsByTime(response)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// arnToServiceSlug — internal function direct tests
// ────────────────────────────────────────────────────────────────────

describe("arnToServiceSlug", () => {
  it("extracts 'ec2' from a standard EC2 instance ARN", () => {
    expect(
      arnToServiceSlug(
        "arn:aws:ec2:us-east-1:123456789012:instance/i-0abcdef1234567890",
      ),
    ).toBe("ec2");
  });

  it("extracts 's3' from an S3 bucket ARN (empty region/account)", () => {
    expect(arnToServiceSlug("arn:aws:s3:::my-production-bucket")).toBe("s3");
  });

  it("extracts 'ec2' from a GovCloud ARN", () => {
    expect(
      arnToServiceSlug(
        "arn:aws-us-gov:ec2:us-gov-west-1:123456789012:instance/i-0abcdef1234567890",
      ),
    ).toBe("ec2");
  });

  it("returns undefined for an invalid/non-ARN string", () => {
    expect(arnToServiceSlug("not-an-arn-at-all")).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(arnToServiceSlug("")).toBeUndefined();
  });

  it("extracts 'lambda' from a Lambda function ARN", () => {
    expect(
      arnToServiceSlug(
        "arn:aws:lambda:us-east-1:123456789012:function:my-function",
      ),
    ).toBe("lambda");
  });

  it("extracts 'rds' from an RDS instance ARN", () => {
    expect(
      arnToServiceSlug("arn:aws:rds:us-west-2:123456789012:db:my-postgres-db"),
    ).toBe("rds");
  });

  it("extracts 'ec2' from a China partition ARN", () => {
    expect(
      arnToServiceSlug(
        "arn:aws-cn:ec2:cn-north-1:123456789012:instance/i-0abc",
      ),
    ).toBe("ec2");
  });
});

// ────────────────────────────────────────────────────────────────────
// Cost distribution — service-level cost split across resources
// ────────────────────────────────────────────────────────────────────

describe("fetchBillingData — cost distribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadProvisions.mockResolvedValue([]);
  });

  it("distributes $10 S3 service cost evenly across 2 S3 buckets ($5.00 each)", async () => {
    const bucket1: ManagedResource = {
      resourceType: "AWS::S3::Bucket",
      arn: "arn:aws:s3:::production-assets-bucket",
      region: "us-east-1",
      createdDate: "2026-03-01",
      estimatedMonthlyCost: "N/A",
    };
    const bucket2: ManagedResource = {
      resourceType: "AWS::S3::Bucket",
      arn: "arn:aws:s3:::backup-data-bucket",
      region: "us-east-1",
      createdDate: "2026-03-15",
      estimatedMonthlyCost: "N/A",
    };

    // Build an MCP response that returns $10 for S3
    const resultsByTime = [
      {
        TimePeriod: { Start: "2026-04-01", End: "2026-05-01" },
        Groups: [
          {
            Keys: ["Amazon Simple Storage Service"],
            Metrics: {
              UnblendedCost: { Amount: "10.00", Unit: "USD" },
            },
          },
        ],
      },
    ];
    const mcpResponse = {
      type: "text",
      text: JSON.stringify({
        status: "success",
        data: {
          preview: [
            { key: "ResultsByTime", value: JSON.stringify(resultsByTime) },
          ],
        },
      }),
    };
    const tools = [createMockTool(ToolName.COST_EXPLORER, mcpResponse)];

    const result = await fetchBillingData([bucket1, bucket2], tools);

    expect(result.size).toBe(2);
    expect(result.get(bucket1.arn)!.actualMonthlyCost).toBe("$5.00/month");
    expect(result.get(bucket2.arn)!.actualMonthlyCost).toBe("$5.00/month");
    expect(result.get(bucket1.arn)!.currency).toBe("USD");
  });

  it("excludes resources with unknown service slug from cost distribution", async () => {
    const unknownResource: ManagedResource = {
      resourceType: "AWS::Custom::Widget",
      arn: "arn:aws:custom:us-east-1:123456789012:widget/my-widget",
      region: "us-east-1",
      createdDate: "2026-03-01",
      estimatedMonthlyCost: "N/A",
    };

    // Even with billing data available, an unknown service slug means
    // the resource cannot be matched to a CE service name.
    const resultsByTime = [
      {
        TimePeriod: { Start: "2026-04-01", End: "2026-05-01" },
        Groups: [
          {
            Keys: ["Amazon Simple Storage Service"],
            Metrics: {
              UnblendedCost: { Amount: "5.00", Unit: "USD" },
            },
          },
        ],
      },
    ];
    const mcpResponse = {
      type: "text",
      text: JSON.stringify({
        status: "success",
        data: {
          preview: [
            { key: "ResultsByTime", value: JSON.stringify(resultsByTime) },
          ],
        },
      }),
    };
    const tools = [createMockTool(ToolName.COST_EXPLORER, mcpResponse)];

    const result = await fetchBillingData([unknownResource], tools);

    // The unknown resource's service slug ("custom") isn't in
    // ARN_SERVICE_TO_CE_SERVICE, so it can't be matched to the S3
    // cost data → no entry in the result map.
    expect(result.size).toBe(0);
  });
});
