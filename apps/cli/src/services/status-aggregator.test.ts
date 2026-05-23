/**
 * Tests for the status aggregator service.
 *
 * @see Story 19.6, AC #5
 */

import { describe, it, expect, vi } from "vitest";
import {
  parseCost,
  formatCost,
  buildStatusData,
  enrichWithBillingData,
} from "./status-aggregator.js";
import type { ManagedResource } from "./list-resources.js";
import type { MemoryService } from "./memory.js";

// ── Mock helpers ────────────────────────────────────────────────────────────

function mockResource(
  overrides: Partial<ManagedResource> = {},
): ManagedResource {
  return {
    resourceType: "AWS::S3::Bucket",
    arn: "arn:aws:s3:::my-bucket",
    region: "us-east-1",
    createdDate: "2026-03-20",
    estimatedMonthlyCost: "$5.00/month",
    ...overrides,
  };
}

function mockMemoryService(
  provisions: Array<{ resourceArn: string; estimatedMonthlyCost: string }> = [],
): MemoryService {
  return {
    readProvisions: vi.fn().mockResolvedValue(
      provisions.map((p) => ({
        runId: "00000000-0000-0000-0000-000000000000",
        resourceType: "AWS::S3::Bucket",
        resourceArn: p.resourceArn,
        region: "us-east-1",
        desiredStateHash: "abc",
        estimatedMonthlyCost: p.estimatedMonthlyCost,
        timestamp: "2026-03-20T00:00:00.000Z",
      })),
    ),
    appendProvision: vi.fn(),
    readFailures: vi.fn().mockResolvedValue([]),
    appendFailure: vi.fn(),
    readPatterns: vi.fn().mockResolvedValue([]),
    upsertPattern: vi.fn(),
  } as unknown as MemoryService;
}

// ── parseCost ───────────────────────────────────────────────────────────────

describe("parseCost", () => {
  it("parses '$1.23/month' to 1.23", () => {
    expect(parseCost("$1.23/month")).toBe(1.23);
  });

  it("parses '$1.23' to 1.23", () => {
    expect(parseCost("$1.23")).toBe(1.23);
  });

  it("parses '$42.50/month' to 42.5", () => {
    expect(parseCost("$42.50/month")).toBe(42.5);
  });

  it("returns 0 for 'N/A'", () => {
    expect(parseCost("N/A")).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(parseCost("")).toBe(0);
  });

  it("returns 0 for unparseable string", () => {
    expect(parseCost("free")).toBe(0);
  });

  // F19 (2026-05-23): per-unit rates return null (NOT 0) so callers
  // can distinguish "variable, exclude from sum" from "zero".
  it("F19: returns null for per-GB rate '$0.0230/GB-month'", () => {
    expect(parseCost("$0.0230/GB-month")).toBeNull();
  });

  it("F19: returns null for per-request rate '$0.0004/request'", () => {
    expect(parseCost("$0.0004/request")).toBeNull();
  });

  it("F19: returns null for per-1000-reqs rate '$0.40/1000 requests'", () => {
    expect(parseCost("$0.40/1000 requests")).toBeNull();
  });

  it("F19: returns null for per-invocation rate '$0.0000002/invocation'", () => {
    expect(parseCost("$0.0000002/invocation")).toBeNull();
  });
});

// ── formatCost ──────────────────────────────────────────────────────────────

describe("formatCost", () => {
  it("formats 1.23 as '$1.23/month'", () => {
    expect(formatCost(1.23)).toBe("$1.23/month");
  });

  it("formats 42.5 as '$42.50/month'", () => {
    expect(formatCost(42.5)).toBe("$42.50/month");
  });

  it("returns 'N/A' for 0", () => {
    expect(formatCost(0)).toBe("N/A");
  });

  it("returns 'N/A' for negative values", () => {
    expect(formatCost(-5)).toBe("N/A");
  });

  // F19 (2026-05-23): lowerBound flag prefixes "≥ " to signal that
  // at least one row was excluded from the sum (per-unit rate).
  it("F19: lowerBound=true prefixes '≥ ' even when cost > 0", () => {
    expect(formatCost(7.59, true)).toBe("≥ $7.59/month");
  });

  it("F19: lowerBound=true renders '≥ $0.00/month' when only per-unit rates were seen", () => {
    expect(formatCost(0, true)).toBe("≥ $0.00/month");
  });

  it("F19: lowerBound=false (default) keeps the original 'N/A' shape for zero cost", () => {
    expect(formatCost(0, false)).toBe("N/A");
  });
});

// ── buildStatusData ─────────────────────────────────────────────────────────

describe("buildStatusData", () => {
  it("produces correct totals for mock resources", async () => {
    const resources = [
      mockResource({
        resourceType: "AWS::S3::Bucket",
        region: "us-east-1",
        estimatedMonthlyCost: "$5.00/month",
      }),
      mockResource({
        resourceType: "AWS::S3::Bucket",
        region: "us-east-1",
        estimatedMonthlyCost: "$3.00/month",
        arn: "arn:aws:s3:::bucket-2",
      }),
      mockResource({
        resourceType: "AWS::Lambda::Function",
        region: "us-east-1",
        estimatedMonthlyCost: "$10.00/month",
        arn: "arn:aws:lambda:us-east-1:123:function:fn1",
      }),
      mockResource({
        resourceType: "AWS::Lambda::Function",
        region: "eu-west-1",
        estimatedMonthlyCost: "$7.50/month",
        arn: "arn:aws:lambda:eu-west-1:123:function:fn2",
      }),
      mockResource({
        resourceType: "AWS::S3::Bucket",
        region: "eu-west-1",
        estimatedMonthlyCost: "$2.50/month",
        arn: "arn:aws:s3:::bucket-3",
      }),
    ];

    const mem = mockMemoryService();
    const result = await buildStatusData(resources, mem);

    expect(result.totalResources).toBe(5);
    expect(result.totalEstimatedMonthlyCost).toBe("$28.00/month");
    expect(result.lastUpdated).toBeTruthy();
  });

  it("groups correctly by type", async () => {
    const resources = [
      mockResource({
        resourceType: "AWS::S3::Bucket",
        estimatedMonthlyCost: "$5.00/month",
      }),
      mockResource({
        resourceType: "AWS::S3::Bucket",
        estimatedMonthlyCost: "$3.00/month",
        arn: "arn:aws:s3:::b2",
      }),
      mockResource({
        resourceType: "AWS::Lambda::Function",
        estimatedMonthlyCost: "$10.00/month",
        arn: "arn:aws:lambda:us-east-1:123:function:fn1",
      }),
    ];

    const mem = mockMemoryService();
    const result = await buildStatusData(resources, mem);

    expect(result.byType).toHaveLength(2);
    // Sorted by count descending — S3 has 2, Lambda has 1
    expect(result.byType[0]!.type).toBe("AWS::S3::Bucket");
    expect(result.byType[0]!.count).toBe(2);
    expect(result.byType[0]!.estimatedMonthlyCost).toBe("$8.00/month");
    expect(result.byType[1]!.type).toBe("AWS::Lambda::Function");
    expect(result.byType[1]!.count).toBe(1);
  });

  it("groups correctly by region", async () => {
    const resources = [
      mockResource({
        region: "us-east-1",
        estimatedMonthlyCost: "$5.00/month",
      }),
      mockResource({
        region: "us-east-1",
        estimatedMonthlyCost: "$3.00/month",
        arn: "arn:aws:s3:::b2",
      }),
      mockResource({
        region: "eu-west-1",
        estimatedMonthlyCost: "$10.00/month",
        arn: "arn:aws:s3:::b3",
      }),
    ];

    const mem = mockMemoryService();
    const result = await buildStatusData(resources, mem);

    expect(result.byRegion).toHaveLength(2);
    expect(result.byRegion[0]!.region).toBe("us-east-1");
    expect(result.byRegion[0]!.count).toBe(2);
    expect(result.byRegion[1]!.region).toBe("eu-west-1");
    expect(result.byRegion[1]!.count).toBe(1);
  });

  it("returns zero totals for empty resources array", async () => {
    const mem = mockMemoryService();
    const result = await buildStatusData([], mem);

    expect(result.totalResources).toBe(0);
    expect(result.totalEstimatedMonthlyCost).toBe("N/A");
    expect(result.byType).toHaveLength(0);
    expect(result.byRegion).toHaveLength(0);
  });

  it("handles N/A costs gracefully", async () => {
    const resources = [
      mockResource({ estimatedMonthlyCost: "N/A" }),
      mockResource({
        estimatedMonthlyCost: "$5.00/month",
        arn: "arn:aws:s3:::b2",
      }),
    ];

    const mem = mockMemoryService();
    const result = await buildStatusData(resources, mem);

    expect(result.totalResources).toBe(2);
    expect(result.totalEstimatedMonthlyCost).toBe("$5.00/month");
  });
});

// ── enrichWithBillingData ───────────────────────────────────────────────────

describe("enrichWithBillingData", () => {
  it("enriches resources with N/A cost from provision log", async () => {
    const resources = [
      mockResource({
        arn: "arn:aws:s3:::my-bucket",
        estimatedMonthlyCost: "N/A",
      }),
    ];

    const mem = mockMemoryService([
      {
        resourceArn: "arn:aws:s3:::my-bucket",
        estimatedMonthlyCost: "$3.50/month",
      },
    ]);

    const result = await enrichWithBillingData(resources, mem);

    expect(result[0]!.estimatedMonthlyCost).toBe("$3.50/month");
  });

  it("does not overwrite existing cost data", async () => {
    const resources = [
      mockResource({
        arn: "arn:aws:s3:::my-bucket",
        estimatedMonthlyCost: "$5.00/month",
      }),
    ];

    const mem = mockMemoryService([
      {
        resourceArn: "arn:aws:s3:::my-bucket",
        estimatedMonthlyCost: "$3.50/month",
      },
    ]);

    const result = await enrichWithBillingData(resources, mem);

    expect(result[0]!.estimatedMonthlyCost).toBe("$5.00/month");
  });

  it("returns resources unchanged when memory service fails", async () => {
    const resources = [mockResource({ estimatedMonthlyCost: "N/A" })];

    const mem = {
      readProvisions: vi.fn().mockRejectedValue(new Error("disk error")),
    } as unknown as MemoryService;

    const result = await enrichWithBillingData(resources, mem);

    expect(result[0]!.estimatedMonthlyCost).toBe("N/A");
  });

  it("returns resources unchanged when no provisions exist", async () => {
    const resources = [mockResource({ estimatedMonthlyCost: "N/A" })];

    const mem = mockMemoryService([]);
    const result = await enrichWithBillingData(resources, mem);

    expect(result[0]!.estimatedMonthlyCost).toBe("N/A");
  });
});
