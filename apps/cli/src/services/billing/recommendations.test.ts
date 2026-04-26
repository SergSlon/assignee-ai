/**
 * Branch-coverage uplift for billing/recommendations.ts — P066 R10b-01.
 *
 * Covers the conditional branches in queryCostAnomalies,
 * queryCostOptimization, and queryComputeOptimizer that were missed by the
 * billing.test.ts integration suite:
 *  - tool not found in list → returns []
 *  - tool.invoke throws → returns [] via logBillingMcpFailure catch
 *  - response with no matching preview key → returns []
 *  - response whose preview value parses to a non-array → returns []
 *  - canonical happy-path with all optional fields exercised
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StructuredTool } from "@langchain/core/tools";
import {
  queryCostAnomalies,
  queryCostOptimization,
  queryComputeOptimizer,
} from "./recommendations.js";
import { ToolName } from "../../constants/tools.js";

// Silence the billing-failure logger so test output stays clean.
vi.mock("./error-handler.js", () => ({
  logBillingMcpFailure: vi.fn(),
}));

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Wrap a preview value the way extractPreviewData expects it. */
function makePreviewResponse(
  key: string,
  value: string,
): { data: { preview: Array<{ key: string; value: string }> } } {
  return { data: { preview: [{ key, value }] } };
}

function makeTool(name: string, response: unknown): StructuredTool {
  return {
    name,
    invoke: vi.fn().mockResolvedValue(response),
  } as unknown as StructuredTool;
}

function makeFailingTool(name: string): StructuredTool {
  return {
    name,
    invoke: vi.fn().mockRejectedValue(new Error("MCP unavailable")),
  } as unknown as StructuredTool;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════════
// queryCostAnomalies
// ══════════════════════════════════════════════════════════════════════════════

describe("queryCostAnomalies", () => {
  it("returns [] when the tool is not in the list (branch: no tool)", async () => {
    const result = await queryCostAnomalies([]);
    expect(result).toEqual([]);
  });

  it("returns [] when tool.invoke throws (branch: catch path)", async () => {
    const tool = makeFailingTool(ToolName.COST_ANOMALY);
    const result = await queryCostAnomalies([tool]);
    expect(result).toEqual([]);
  });

  it("returns [] when preview has no Anomalies key (branch: anomaliesStr falsy)", async () => {
    const response = makePreviewResponse("OtherKey", "[]");
    const tool = makeTool(ToolName.COST_ANOMALY, response);
    const result = await queryCostAnomalies([tool]);
    expect(result).toEqual([]);
  });

  it("returns [] when preview value parses to a non-array (branch: !Array.isArray)", async () => {
    const response = makePreviewResponse("Anomalies", '{"not":"array"}');
    const tool = makeTool(ToolName.COST_ANOMALY, response);
    const result = await queryCostAnomalies([tool]);
    expect(result).toEqual([]);
  });

  it("maps real anomaly shapes with AWS-style keys (branch: happy path, PascalCase fields)", async () => {
    const anomalies = [
      {
        AnomalyId: "anom-001",
        DimensionValue: "Amazon EC2",
        MaxImpact: "47.23",
        AnomalyStartDate: "2026-04-01",
        AnomalyEndDate: "2026-04-05",
        Severity: "HIGH",
      },
    ];
    const response = makePreviewResponse(
      "Anomalies",
      JSON.stringify(anomalies),
    );
    const tool = makeTool(ToolName.COST_ANOMALY, response);
    const result = await queryCostAnomalies([tool]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      anomalyId: "anom-001",
      service: "Amazon EC2",
      impact: "47.23",
      startDate: "2026-04-01",
      endDate: "2026-04-05",
      severity: "HIGH",
      source: "mcp",
    });
  });

  it("maps anomaly shapes with camelCase keys (branch: alternate key lookup)", async () => {
    const anomalies = [
      {
        anomalyId: "anom-002",
        service: "Amazon S3",
        impact: "12.50",
        startDate: "2026-04-10",
        endDate: "2026-04-12",
        // severity absent → falls back to "MEDIUM"
      },
    ];
    const response = makePreviewResponse(
      "anomalies",
      JSON.stringify(anomalies),
    );
    const tool = makeTool(ToolName.COST_ANOMALY, response);
    const result = await queryCostAnomalies([tool]);
    expect(result).toHaveLength(1);
    expect(result[0]!.severity).toBe("MEDIUM");
  });

  it("uses TotalImpact when MaxImpact absent (branch: impact fallback chain)", async () => {
    const anomalies = [
      {
        anomalyId: "anom-003",
        DimensionValue: "AWS Lambda",
        TotalImpact: "5.99",
        AnomalyStartDate: "2026-04-15",
        AnomalyEndDate: "2026-04-16",
        Severity: "LOW",
      },
    ];
    const response = makePreviewResponse(
      "Anomalies",
      JSON.stringify(anomalies),
    );
    const tool = makeTool(ToolName.COST_ANOMALY, response);
    const result = await queryCostAnomalies([tool]);
    expect(result[0]!.impact).toBe("5.99");
  });

  it("falls back to 'Unknown' impact when no known key present", async () => {
    const anomalies = [{ anomalyId: "anom-004" }];
    const response = makePreviewResponse(
      "Anomalies",
      JSON.stringify(anomalies),
    );
    const tool = makeTool(ToolName.COST_ANOMALY, response);
    const result = await queryCostAnomalies([tool]);
    expect(result[0]!.impact).toBe("Unknown");
    expect(result[0]!.service).toBe("Unknown Service");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// queryCostOptimization
// ══════════════════════════════════════════════════════════════════════════════

describe("queryCostOptimization", () => {
  it("returns [] when the tool is not in the list", async () => {
    const result = await queryCostOptimization([]);
    expect(result).toEqual([]);
  });

  it("returns [] when tool.invoke throws", async () => {
    const tool = makeFailingTool(ToolName.COST_OPTIMIZATION);
    const result = await queryCostOptimization([tool]);
    expect(result).toEqual([]);
  });

  it("returns [] when preview has no Recommendations key", async () => {
    const response = makePreviewResponse("OtherKey", "[]");
    const tool = makeTool(ToolName.COST_OPTIMIZATION, response);
    const result = await queryCostOptimization([tool]);
    expect(result).toEqual([]);
  });

  it("returns [] when parsed value is not an array", async () => {
    const response = makePreviewResponse("Recommendations", '"just a string"');
    const tool = makeTool(ToolName.COST_OPTIMIZATION, response);
    const result = await queryCostOptimization([tool]);
    expect(result).toEqual([]);
  });

  it("maps recommendations with PascalCase AWS keys", async () => {
    const recs = [
      {
        RecommendationId: "rec-001",
        ResourceArn:
          "arn:aws:ec2:us-east-1:210987654321:instance/i-0abcdef1234567890",
        ResourceType: "AWS::EC2::Instance",
        Finding: "Underutilized instance",
        EstimatedMonthlySavings: "45.00",
        Currency: "USD",
      },
    ];
    const response = makePreviewResponse(
      "Recommendations",
      JSON.stringify(recs),
    );
    const tool = makeTool(ToolName.COST_OPTIMIZATION, response);
    const result = await queryCostOptimization([tool]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "rec-001",
      resourceArn:
        "arn:aws:ec2:us-east-1:210987654321:instance/i-0abcdef1234567890",
      resourceType: "AWS::EC2::Instance",
      finding: "Underutilized instance",
      estimatedSavings: "45.00",
      currency: "USD",
      source: "mcp",
    });
  });

  it("maps recommendations with camelCase keys (branch: alternate lookup)", async () => {
    const recs = [
      {
        id: "rec-002",
        resourceArn: "arn:aws:lambda:us-east-1:210987654321:function:my-fn",
        resourceType: "AWS::Lambda::Function",
        finding: "Oversized memory",
        estimatedSavings: "8.50",
        currency: "USD",
      },
    ];
    const response = makePreviewResponse(
      "recommendations",
      JSON.stringify(recs),
    );
    const tool = makeTool(ToolName.COST_OPTIMIZATION, response);
    const result = await queryCostOptimization([tool]);
    expect(result[0]!.id).toBe("rec-002");
  });

  it("uses Description fallback when Finding absent (branch: finding fallback)", async () => {
    const recs = [
      {
        RecommendationId: "rec-003",
        Description: "Right-size this instance",
      },
    ];
    const response = makePreviewResponse(
      "Recommendations",
      JSON.stringify(recs),
    );
    const tool = makeTool(ToolName.COST_OPTIMIZATION, response);
    const result = await queryCostOptimization([tool]);
    expect(result[0]!.finding).toBe("Right-size this instance");
  });

  it("uses N/A when EstimatedMonthlySavings absent (branch: savings fallback)", async () => {
    const recs = [{ RecommendationId: "rec-004" }];
    const response = makePreviewResponse(
      "Recommendations",
      JSON.stringify(recs),
    );
    const tool = makeTool(ToolName.COST_OPTIMIZATION, response);
    const result = await queryCostOptimization([tool]);
    expect(result[0]!.estimatedSavings).toBe("N/A");
    expect(result[0]!.currency).toBe("USD");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// queryComputeOptimizer
// ══════════════════════════════════════════════════════════════════════════════

describe("queryComputeOptimizer", () => {
  it("returns [] when the tool is not in the list", async () => {
    const result = await queryComputeOptimizer([]);
    expect(result).toEqual([]);
  });

  it("returns [] when tool.invoke throws", async () => {
    const tool = makeFailingTool(ToolName.COMPUTE_OPTIMIZER);
    const result = await queryComputeOptimizer([tool]);
    expect(result).toEqual([]);
  });

  it("returns [] when preview has no Recommendations key", async () => {
    const response = makePreviewResponse("OtherKey", "[]");
    const tool = makeTool(ToolName.COMPUTE_OPTIMIZER, response);
    const result = await queryComputeOptimizer([tool]);
    expect(result).toEqual([]);
  });

  it("returns [] when parsed value is not an array", async () => {
    const response = makePreviewResponse("Recommendations", "42");
    const tool = makeTool(ToolName.COMPUTE_OPTIMIZER, response);
    const result = await queryComputeOptimizer([tool]);
    expect(result).toEqual([]);
  });

  it("maps compute recommendations with PascalCase AWS keys", async () => {
    const recs = [
      {
        ResourceArn:
          "arn:aws:ec2:us-east-1:210987654321:instance/i-0abcdef1234567890",
        ResourceType: "AWS::EC2::Instance",
        Finding: "OVER_PROVISIONED",
        CurrentInstanceType: "m5.xlarge",
        RecommendedInstanceType: "m5.large",
        EstimatedMonthlySavings: "60.00",
      },
    ];
    const response = makePreviewResponse(
      "Recommendations",
      JSON.stringify(recs),
    );
    const tool = makeTool(ToolName.COMPUTE_OPTIMIZER, response);
    const result = await queryComputeOptimizer([tool]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      resourceArn:
        "arn:aws:ec2:us-east-1:210987654321:instance/i-0abcdef1234567890",
      resourceType: "AWS::EC2::Instance",
      finding: "OVER_PROVISIONED",
      currentConfig: "m5.xlarge",
      recommendedConfig: "m5.large",
      estimatedSavings: "60.00",
      source: "mcp",
    });
  });

  it("uses camelCase + CurrentConfiguration fallbacks (branch: alternate config keys)", async () => {
    const recs = [
      {
        resourceArn: "arn:aws:lambda:us-east-1:210987654321:function:fn",
        resourceType: "AWS::Lambda::Function",
        finding: "OVER_PROVISIONED",
        currentConfig: "512MB",
        recommendedConfig: "256MB",
        estimatedSavings: "N/A",
      },
    ];
    const response = makePreviewResponse(
      "recommendations",
      JSON.stringify(recs),
    );
    const tool = makeTool(ToolName.COMPUTE_OPTIMIZER, response);
    const result = await queryComputeOptimizer([tool]);
    expect(result[0]!.currentConfig).toBe("512MB");
    expect(result[0]!.recommendedConfig).toBe("256MB");
  });

  it("uses CurrentConfiguration fallback when CurrentInstanceType absent", async () => {
    const recs = [
      {
        ResourceArn: "arn:aws:ecs:us-east-1:210987654321:service/cluster/svc",
        ResourceType: "AWS::ECS::Service",
        Finding: "OVER_PROVISIONED",
        CurrentConfiguration: "2 vCPU / 4 GB",
        RecommendedConfiguration: "1 vCPU / 2 GB",
      },
    ];
    const response = makePreviewResponse(
      "Recommendations",
      JSON.stringify(recs),
    );
    const tool = makeTool(ToolName.COMPUTE_OPTIMIZER, response);
    const result = await queryComputeOptimizer([tool]);
    expect(result[0]!.currentConfig).toBe("2 vCPU / 4 GB");
    expect(result[0]!.recommendedConfig).toBe("1 vCPU / 2 GB");
  });

  it("uses N/A when savings absent (branch: savings fallback)", async () => {
    const recs = [
      {
        ResourceArn:
          "arn:aws:ec2:us-east-1:210987654321:instance/i-0000000000000001",
        ResourceType: "AWS::EC2::Instance",
        Finding: "OPTIMIZED",
        CurrentInstanceType: "t3.micro",
        RecommendedInstanceType: "t3.micro",
      },
    ];
    const response = makePreviewResponse(
      "Recommendations",
      JSON.stringify(recs),
    );
    const tool = makeTool(ToolName.COMPUTE_OPTIMIZER, response);
    const result = await queryComputeOptimizer([tool]);
    expect(result[0]!.estimatedSavings).toBe("N/A");
  });
});
