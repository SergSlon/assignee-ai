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
  queryCostAnomalies,
  queryCostOptimization,
  queryComputeOptimizer,
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

// Mock the logger so we can assert warn-level emissions from the 6 catch
// sites in billing.ts (P1-R2-3 regression — no more bare `catch {}`).
const mockLog = vi.fn();
vi.mock("../utils/logger.js", async () => {
  const actual =
    await vi.importActual<typeof import("../utils/logger.js")>(
      "../utils/logger.js",
    );
  return {
    ...actual,
    log: (...args: unknown[]) => mockLog(...args),
  };
});

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
    // Story 46.2: live MCP cost-explorer responses tag source "mcp".
    expect(entry.source).toBe("mcp");
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
    // Story 46.2: provision-log fallback rows must tag source "offline"
    // so the display layer can render "(from log)" — the user MUST be
    // able to tell stale log replay from live AWS data.
    expect(entry.source).toBe("offline");
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
    const entry = result.get(sampleResource.arn)!;
    expect(entry.actualMonthlyCost).toBe("$0.05/month");
    // Story 46.2: provision-log fallback rows MUST tag source "offline"
    // even when triggered by an MCP failure (not just an empty cost map).
    expect(entry.source).toBe("offline");
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
    const entry = result.get(sampleResource.arn)!;
    expect(entry.actualMonthlyCost).toBe("$0.05/month");
    expect(entry.source).toBe("offline");
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

    // Polish item 1 (2026-05-09): unified `$X.XX/mo` shape so destroy
    // savings match the `assignee list` cost column.
    expect(result).toBe("$0.02/mo saved");
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

    // Polish item 1 (2026-05-09): unified `$X.XX/mo` shape so destroy
    // savings match the `assignee list` cost column.
    expect(result).toBe("$2.50/mo saved");
  });

  it('returns "No cost savings" when no data available (Epic 92 A-08/D-15)', async () => {
    // Epic 92 Wave 4 (e92.4.a): previously returned "N/A" which concatenated
    // to "Estimated savings: N/A" in destroy output — awkward. The sanitized
    // fallback now reads cleanly when rendered verbatim.
    const result = await getCostSavingsEstimate(sampleResource.arn);

    expect(result).toBe("No cost savings");
  });

  it('returns "No cost savings" when MCP tools fail (Epic 92 A-08/D-15)', async () => {
    const failingTool = createFailingMockTool(
      ToolName.COST_EXPLORER,
      new Error("Server down"),
    );

    const result = await getCostSavingsEstimate(sampleResource.arn, [
      failingTool,
    ]);

    expect(result).toBe("No cost savings");
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

// ────────────────────────────────────────────────────────────────────
// New billing tools (Story 45.3)
// ────────────────────────────────────────────────────────────────────

function makeBillingTool(
  name: string,
  response: unknown,
): { name: string; invoke: ReturnType<typeof vi.fn> } {
  return {
    name,
    invoke: vi.fn().mockResolvedValue(response),
  };
}

function makeBillingSessionResponse(
  key: string,
  data: unknown,
): {
  status: string;
  data: { preview: Array<{ key: string; value: string }> };
} {
  return {
    status: "success",
    data: {
      preview: [{ key, value: JSON.stringify(data) }],
    },
  };
}

describe("queryCostAnomalies (Story 45.3)", () => {
  it("returns parsed anomalies from session-based response", async () => {
    const anomalies = [
      {
        AnomalyId: "a-123",
        DimensionValue: "Amazon EC2",
        MaxImpact: "$45.00",
        AnomalyStartDate: "2026-04-05",
        AnomalyEndDate: "2026-04-07",
        Severity: "HIGH",
      },
    ];
    const tool = makeBillingTool(
      ToolName.COST_ANOMALY,
      makeBillingSessionResponse("Anomalies", anomalies),
    );

    const result = await queryCostAnomalies([tool as never]);

    expect(result).toHaveLength(1);
    expect(result[0]!.anomalyId).toBe("a-123");
    expect(result[0]!.service).toBe("Amazon EC2");
    expect(result[0]!.severity).toBe("HIGH");
    expect(result[0]!.impact).toBe("$45.00");
    // Story 46.2: live billing MCP responses must be tagged "mcp" so the
    // display layer can render the (live) suffix.
    expect(result[0]!.source).toBe("mcp");
  });

  it("returns empty array when tool is missing", async () => {
    const result = await queryCostAnomalies([]);
    expect(result).toEqual([]);
  });

  it("returns empty array when tool throws", async () => {
    const tool = {
      name: ToolName.COST_ANOMALY,
      invoke: vi.fn().mockRejectedValue(new Error("server down")),
    };

    const result = await queryCostAnomalies([tool as never]);
    expect(result).toEqual([]);
  });

  it("returns empty array when response has no Anomalies key", async () => {
    const tool = makeBillingTool(
      ToolName.COST_ANOMALY,
      makeBillingSessionResponse("SomethingElse", []),
    );

    const result = await queryCostAnomalies([tool as never]);
    expect(result).toEqual([]);
  });
});

describe("queryCostOptimization (Story 45.3)", () => {
  it("returns parsed recommendations from session-based response", async () => {
    const recs = [
      {
        RecommendationId: "r-456",
        ResourceArn: "arn:aws:ec2:us-east-1:210987654321:instance/i-abc",
        ResourceType: "EC2 Instance",
        Finding: "Right-size to t3.small",
        EstimatedMonthlySavings: "25.00",
        Currency: "USD",
      },
    ];
    const tool = makeBillingTool(
      ToolName.COST_OPTIMIZATION,
      makeBillingSessionResponse("Recommendations", recs),
    );

    const result = await queryCostOptimization([tool as never]);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("r-456");
    expect(result[0]!.resourceArn).toBe(
      "arn:aws:ec2:us-east-1:210987654321:instance/i-abc",
    );
    expect(result[0]!.finding).toBe("Right-size to t3.small");
    expect(result[0]!.estimatedSavings).toBe("25.00");
    // Story 46.2: live billing MCP responses must be tagged "mcp".
    expect(result[0]!.source).toBe("mcp");
  });

  it("returns empty array when tool is missing", async () => {
    const result = await queryCostOptimization([]);
    expect(result).toEqual([]);
  });

  it("returns empty array when tool throws", async () => {
    const tool = {
      name: ToolName.COST_OPTIMIZATION,
      invoke: vi.fn().mockRejectedValue(new Error("timeout")),
    };

    const result = await queryCostOptimization([tool as never]);
    expect(result).toEqual([]);
  });
});

describe("queryComputeOptimizer (Story 45.3)", () => {
  it("returns parsed rightsizing recommendations", async () => {
    const recs = [
      {
        ResourceArn: "arn:aws:ec2:us-east-1:210987654321:instance/i-xyz",
        ResourceType: "EC2 Instance",
        Finding: "OVER_PROVISIONED",
        CurrentInstanceType: "m5.xlarge",
        RecommendedInstanceType: "m5.large",
        EstimatedMonthlySavings: "62.50",
      },
    ];
    const tool = makeBillingTool(
      ToolName.COMPUTE_OPTIMIZER,
      makeBillingSessionResponse("Recommendations", recs),
    );

    const result = await queryComputeOptimizer([tool as never]);

    expect(result).toHaveLength(1);
    expect(result[0]!.resourceArn).toBe(
      "arn:aws:ec2:us-east-1:210987654321:instance/i-xyz",
    );
    expect(result[0]!.finding).toBe("OVER_PROVISIONED");
    expect(result[0]!.currentConfig).toBe("m5.xlarge");
    expect(result[0]!.recommendedConfig).toBe("m5.large");
    expect(result[0]!.estimatedSavings).toBe("62.50");
    // Story 46.2: live billing MCP responses must be tagged "mcp".
    expect(result[0]!.source).toBe("mcp");
  });

  it("returns empty array when tool is missing", async () => {
    const result = await queryComputeOptimizer([]);
    expect(result).toEqual([]);
  });

  it("returns empty array when response is malformed", async () => {
    const tool = makeBillingTool(ToolName.COMPUTE_OPTIMIZER, {
      status: "success",
      data: { preview: "not-an-array" },
    });

    const result = await queryComputeOptimizer([tool as never]);
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P1-R2-3 regression — every former bare `catch {}` now emits a structured
// warn-level log event. Six sites: extractResultsByTime (3x),
// queryBillingMcp (1x), fetchBillingData (1x), extractPreviewData (1x).
// ─────────────────────────────────────────────────────────────────────────────

describe("billing.ts structured-log emission on catch (P1-R2-3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadProvisions.mockResolvedValue([]);
  });

  function assertBillingWarn(action: string): void {
    expect(mockLog).toHaveBeenCalled();
    const events = mockLog.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter(
        (ev) =>
          ev &&
          ev["runId"] === "billing-mcp" &&
          ev["level"] === "warn" &&
          ev["action"] === "billing_mcp_query_failed",
      );
    expect(
      events.some(
        (ev) =>
          (ev["extras"] as Record<string, unknown>)?.["billingAction"] ===
          action,
      ),
    ).toBe(true);
  }

  it("extractResultsByTime.parseTextWrapper — emits warn on bad wrapper JSON", () => {
    // Realistic malformed MCP wrapper — a text body that isn't valid JSON.
    const r = extractResultsByTime({ text: "{malformed-json" });
    expect(r).toEqual([]);
    assertBillingWarn("extractResultsByTime.parseTextWrapper");
  });

  it("extractResultsByTime.parseResultsByTime — emits warn on bad ResultsByTime JSON", () => {
    const response = {
      status: "success",
      data: {
        preview: [{ key: "ResultsByTime", value: "{not-json" }],
      },
    };
    const r = extractResultsByTime(response);
    expect(r).toEqual([]);
    assertBillingWarn("extractResultsByTime.parseResultsByTime");
  });

  it("queryBillingMcp.getCostAndUsage — emits warn on tool.invoke rejection", async () => {
    const failingTool = createFailingMockTool(
      ToolName.COST_EXPLORER,
      new Error("AccessDeniedException: not authorized for ce:GetCostAndUsage"),
    );
    const result = await fetchBillingData([sampleResource], [failingTool]);
    expect(result.size).toBe(0);
    assertBillingWarn("queryBillingMcp.getCostAndUsage");
  });

  it("fetchBillingData.queryBillingMcp — emits warn when the inner query throws", async () => {
    // Force queryBillingMcp itself to throw by returning a tool whose invoke
    // rejects AFTER the outer try — simulated via a tool that throws
    // synchronously during .invoke() lookup. The inner catch already logs;
    // the outer catch requires a synchronous throw from find(). Instead we
    // assert the inner log fires in the non-fallback path above. For the
    // OUTER catch we induce a throw via a tool whose .name getter throws.
    const throwingTool = {
      get name(): string {
        throw new Error("boom during tool.name access");
      },
      invoke: async () => ({}),
    };
    const result = await fetchBillingData(
      [sampleResource],
      [throwingTool as never],
    );
    // Fell through to provision-log fallback (empty -> size 0).
    expect(result.size).toBe(0);
    assertBillingWarn("fetchBillingData.queryBillingMcp");
  });

  it("extractPreviewData.parseTextWrapper — emits warn via queryCostAnomalies path", async () => {
    // queryCostAnomalies -> extractPreviewData is the real call site.
    // Force the text-wrapper parse to fail with unparseable JSON.
    const tool = {
      name: ToolName.COST_ANOMALY,
      description: "",
      schema: {},
      invoke: async () => ({ text: "{broken-json-in-text-wrapper" }),
    };
    const result = await queryCostAnomalies([tool as never]);
    expect(result).toEqual([]);
    assertBillingWarn("extractPreviewData.parseTextWrapper");
  });
});
