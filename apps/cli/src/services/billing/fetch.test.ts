/**
 * Epic 92 Wave 4 (e92.4.a) — savings-formatter sanitation tests.
 *
 * Complements the legacy suite in `apps/cli/src/services/billing.test.ts`
 * which tests the happy-path wiring. This file pins display-side behavior
 * for the three sanitation buckets (A-08, B-21, D-15, D-18) and also
 * pins SNS + DDB billing-map output to raw MCP response strings (A-10).
 *
 * All mocks use captured MCP fixtures — no synthetic placeholder values.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CostEstimateLabel } from "@assignee/core";
import {
  fetchBillingData,
  formatSavingsDisplay,
  getCostSavingsEstimate,
} from "./fetch.js";
import type { ManagedResource } from "../list-resources.js";
import {
  McpMocks,
  createBillingMockTool,
} from "../../test-fixtures/mcp-mock-responses.js";

vi.mock("../memory.js", () => ({
  defaultMemoryService: {
    readProvisions: vi.fn().mockResolvedValue([]),
  },
}));

import { defaultMemoryService } from "../memory.js";
const mockReadProvisions = vi.mocked(defaultMemoryService.readProvisions);

describe("formatSavingsDisplay (Epic 92 Wave 4.a)", () => {
  describe("bucket 1: parseable dollar amount → '{cost} saved'", () => {
    it("formats $X.XX/month", () => {
      expect(formatSavingsDisplay("$0.02/month")).toBe("$0.02/month saved");
    });

    it("formats $X.XX/mo abbreviation", () => {
      expect(formatSavingsDisplay("$3.00/mo")).toBe("$3.00/mo saved");
    });

    it("formats ~$XX.XX/mo approximate prefix", () => {
      expect(formatSavingsDisplay("~$32.85/mo")).toBe("~$32.85/mo saved");
    });

    it("formats integer-only $N/mo", () => {
      expect(formatSavingsDisplay("$5/mo")).toBe("$5/mo saved");
    });

    it("formats cent-precision $X.XX/GB-month", () => {
      expect(formatSavingsDisplay("$0.0230/GB-month")).toBe(
        "$0.0230/GB-month saved",
      );
    });
  });

  describe("bucket 2: Free / No charge → 'Free, $0.00 savings' (B-21 + D-18)", () => {
    it("formats CostEstimateLabel.FREE", () => {
      expect(formatSavingsDisplay(CostEstimateLabel.FREE)).toBe(
        "Free, $0.00 savings",
      );
    });

    it("formats CostEstimateLabel.NO_CHARGE", () => {
      expect(formatSavingsDisplay(CostEstimateLabel.NO_CHARGE)).toBe(
        "Free, $0.00 savings",
      );
    });

    it("uses CostEstimateLabel.FREE as the source of truth (not a literal)", () => {
      expect(CostEstimateLabel.FREE).toBe("Free");
      expect(CostEstimateLabel.NO_CHARGE).toBe("No charge");
    });
  });

  describe("bucket 3: non-parseable labels → 'No cost savings' (A-08 + D-15)", () => {
    it("formats CostEstimateLabel.NA", () => {
      expect(formatSavingsDisplay(CostEstimateLabel.NA)).toBe(
        "No cost savings",
      );
    });

    it("formats SQS standard-queue per-request label", () => {
      expect(formatSavingsDisplay("Per-request pricing (standard queue)")).toBe(
        "No cost savings",
      );
    });

    it("formats SQS FIFO-queue per-request label", () => {
      expect(formatSavingsDisplay("Per-request pricing (FIFO queue)")).toBe(
        "No cost savings",
      );
    });

    it("formats per-GB pricing label", () => {
      expect(formatSavingsDisplay("Per-GB pricing")).toBe("No cost savings");
    });

    it("formats empty string as no-savings", () => {
      expect(formatSavingsDisplay("")).toBe("No cost savings");
    });
  });
});

const s3Resource: ManagedResource = {
  resourceType: "AWS::S3::Bucket",
  arn: "arn:aws:s3:::my-assignee-bucket-20260322",
  region: "us-east-1",
  createdDate: "2026-03-22",
  estimatedMonthlyCost: "N/A",
};

describe("getCostSavingsEstimate (Epic 92 Wave 4.a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadProvisions.mockResolvedValue([]);
  });

  it("returns '{cost} saved' when MCP returns parseable dollar amount", async () => {
    const tools = [
      createBillingMockTool(McpMocks.billing.s3BucketCost.success),
    ];
    const result = await getCostSavingsEstimate(s3Resource.arn, tools);
    expect(result).toBe("$0.02/month saved");
  });

  it("returns 'Free, $0.00 savings' when provision-log stored CostEstimateLabel.FREE (B-21)", async () => {
    mockReadProvisions.mockResolvedValue([
      {
        runId: "00000000-0000-0000-0000-000000000010",
        resourceType: "AWS::EC2::SecurityGroup",
        resourceArn: s3Resource.arn,
        region: "us-east-1",
        desiredStateHash: "free-resource",
        estimatedMonthlyCost: CostEstimateLabel.FREE,
        timestamp: "2026-04-15T00:00:00.000Z",
      },
    ]);
    const result = await getCostSavingsEstimate(s3Resource.arn);
    expect(result).toBe("Free, $0.00 savings");
  });

  it("returns 'Free, $0.00 savings' when provision-log stored 'No charge' (D-18)", async () => {
    mockReadProvisions.mockResolvedValue([
      {
        runId: "00000000-0000-0000-0000-000000000011",
        resourceType: "AWS::SSM::Parameter",
        resourceArn: s3Resource.arn,
        region: "us-east-1",
        desiredStateHash: "ssm-param",
        estimatedMonthlyCost: CostEstimateLabel.NO_CHARGE,
        timestamp: "2026-04-15T00:00:00.000Z",
      },
    ]);
    const result = await getCostSavingsEstimate(s3Resource.arn);
    expect(result).toBe("Free, $0.00 savings");
  });

  it("returns 'No cost savings' when provision-log stored 'Per-request pricing' label (A-08)", async () => {
    mockReadProvisions.mockResolvedValue([
      {
        runId: "00000000-0000-0000-0000-000000000012",
        resourceType: "AWS::SQS::Queue",
        resourceArn: s3Resource.arn,
        region: "us-east-1",
        desiredStateHash: "sqs-standard",
        estimatedMonthlyCost: "Per-request pricing (standard queue)",
        timestamp: "2026-04-15T00:00:00.000Z",
      },
    ]);
    const result = await getCostSavingsEstimate(s3Resource.arn);
    expect(result).toBe("No cost savings");
  });

  it("returns 'No cost savings' when MCP + provision-log both empty (A-08/D-15)", async () => {
    const result = await getCostSavingsEstimate(s3Resource.arn);
    expect(result).toBe("No cost savings");
  });
});

const snsResource: ManagedResource = {
  resourceType: "AWS::SNS::Topic",
  arn: "arn:aws:sns:us-east-1:210987654321:alerts",
  region: "us-east-1",
  createdDate: "2026-04-15",
  estimatedMonthlyCost: "N/A",
};

const ddbResource: ManagedResource = {
  resourceType: "AWS::DynamoDB::Table",
  arn: "arn:aws:dynamodb:us-east-1:210987654321:table/events",
  region: "us-east-1",
  createdDate: "2026-04-15",
  estimatedMonthlyCost: "N/A",
};

describe("fetchBillingData SNS/DDB MCP-response pinning (A-10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadProvisions.mockResolvedValue([]);
  });

  it("pins SNS actualMonthlyCost to $-formatted raw MCP Unblended amount", async () => {
    const snsMcpResponse = {
      status: "success",
      data: {
        status: "success",
        data_stored: true,
        table_name: "getCostAndUsage_mock",
        schema: ["key", "value"],
        preview: [
          {
            key: "ResultsByTime",
            value: JSON.stringify([
              {
                TimePeriod: { Start: "2026-04-01", End: "2026-05-01" },
                Groups: [
                  {
                    Keys: ["Amazon Simple Notification Service"],
                    Metrics: {
                      UnblendedCost: { Amount: "0.50", Unit: "USD" },
                    },
                  },
                ],
                Total: {},
                Estimated: true,
              },
            ]),
          },
        ],
      },
    };
    const tools = [createBillingMockTool(snsMcpResponse)];
    const result = await fetchBillingData([snsResource], tools);
    const entry = result.get(snsResource.arn)!;
    expect(entry.actualMonthlyCost).toBe("$0.50/month");
    expect(entry.currency).toBe("USD");
    expect(entry.source).toBe("mcp");
  });

  it("pins DDB actualMonthlyCost to $-formatted raw MCP Unblended amount", async () => {
    const ddbMcpResponse = {
      status: "success",
      data: {
        status: "success",
        data_stored: true,
        table_name: "getCostAndUsage_mock",
        schema: ["key", "value"],
        preview: [
          {
            key: "ResultsByTime",
            value: JSON.stringify([
              {
                TimePeriod: { Start: "2026-04-01", End: "2026-05-01" },
                Groups: [
                  {
                    Keys: ["Amazon DynamoDB"],
                    Metrics: {
                      UnblendedCost: { Amount: "1.25", Unit: "USD" },
                    },
                  },
                ],
                Total: {},
                Estimated: true,
              },
            ]),
          },
        ],
      },
    };
    const tools = [createBillingMockTool(ddbMcpResponse)];
    const result = await fetchBillingData([ddbResource], tools);
    const entry = result.get(ddbResource.arn)!;
    expect(entry.actualMonthlyCost).toBe("$1.25/month");
    expect(entry.currency).toBe("USD");
    expect(entry.source).toBe("mcp");
  });
});
