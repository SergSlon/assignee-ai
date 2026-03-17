import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionStatus } from "@assignee/core";
import { preflightGuardNode } from "./preflight-guard.js";
import {
  CostEstimate,
  LambdaPricing,
  PricingUnit,
} from "../constants/pricing.js";
import type { StructuredTool } from "@langchain/core/tools";

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    userIntent: "Create an S3 bucket",
    runId: "run-test-456",
    executionStatus: ExecutionStatus.PENDING,
    executionMode: "plan",
    resourceType: "AWS::S3::Bucket",
    resourceSchema: undefined,
    desiredState: undefined,
    estimatedMonthlyCost: undefined,
    requestToken: undefined,
    resourceArn: undefined,
    errorMessage: undefined,
    startedAt: undefined,
    messages: [],
    preflightPassed: false,
    preflightErrors: [],
    preflightMode: "local",
    ...overrides,
  } as unknown as Parameters<typeof preflightGuardNode>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("preflightGuardNode", () => {
  it("fails with actionable message when required schema fields are missing from desiredState", async () => {
    const result = await preflightGuardNode(
      makeState({
        resourceType: "AWS::Lambda::Function",
        resourceSchema: { required: ["FunctionName", "Runtime", "Role"] },
        desiredState: { FunctionName: "my-fn", Runtime: "nodejs22.x" }, // Role missing
      }),
    );
    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("Role");
    expect(result.errorMessage).toContain("AWS::Lambda::Function");
    expect(result.preflightPassed).toBeUndefined();
  });

  it("passes preflight when all required schema fields are present", async () => {
    const result = await preflightGuardNode(
      makeState({
        resourceType: "AWS::Lambda::Function",
        resourceSchema: { required: ["FunctionName", "Runtime", "Role"] },
        desiredState: {
          FunctionName: "my-fn",
          Runtime: "nodejs22.x",
          Role: "arn:aws:iam::123456789012:role/my-role",
        },
      }),
    );
    expect(result.executionStatus).toBeUndefined();
    expect(result.preflightPassed).toBe(true);
  });

  it("sets preflightPassed: true", async () => {
    const result = await preflightGuardNode(makeState());
    expect(result.preflightPassed).toBe(true);
  });

  it("returns Free for IAM::Role without calling pricing tool", async () => {
    const pricingTool = {
      name: "get_pricing",
      invoke: vi.fn(),
    } as unknown as StructuredTool;
    const result = await preflightGuardNode(
      makeState({ resourceType: "AWS::IAM::Role" }),
      [pricingTool],
    );
    expect(result.estimatedMonthlyCost).toBe(CostEstimate.FREE);
    expect(pricingTool.invoke).not.toHaveBeenCalled();
  });

  it("returns N/A when no pricing tool is available", async () => {
    const result = await preflightGuardNode(makeState(), []);
    expect(result.estimatedMonthlyCost).toBe(CostEstimate.NA);
  });

  it("skips when executionStatus is already FAILED", async () => {
    const result = await preflightGuardNode(
      makeState({ executionStatus: ExecutionStatus.FAILED }),
    );
    expect(result).toEqual({});
  });

  it("returns N/A on pricing timeout (non-blocking)", async () => {
    // Uses CostEstimate.NA implicitly — verified via string equality
    const slowTool = {
      name: "get_pricing",
      invoke: vi.fn(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ type: "text", text: "{}" }), 10000),
          ),
      ),
    } as unknown as StructuredTool;

    const result = await preflightGuardNode(makeState(), [slowTool]);
    // Pricing timed out → N/A, preflightPassed still true
    expect(result.preflightPassed).toBe(true);
    expect(result.estimatedMonthlyCost).toBe(CostEstimate.NA);
  }, 5000);

  it("computes Lambda estimate from default memory without calling pricing API", async () => {
    const pricingTool = {
      name: "get_pricing",
      invoke: vi.fn(),
    } as unknown as StructuredTool;
    const result = await preflightGuardNode(
      makeState({ resourceType: "AWS::Lambda::Function" }),
      [pricingTool],
    );
    // Default 128MB: duration cost = 1M × 0.1s × (128/1024) × $0.0000166667 = $0.208333
    // Total = $0.20 (requests) + $0.208333 (duration) ≈ $0.41
    expect(result.estimatedMonthlyCost).toMatch(/^~\$0\.41\/million req/);
    expect(result.estimatedMonthlyCost).toContain(
      `${LambdaPricing.DEFAULT_MEMORY_MB}MB`,
    );
    expect(result.preflightPassed).toBe(true);
    expect(pricingTool.invoke).not.toHaveBeenCalled();
  });

  it("computes Lambda estimate using MemorySize from desiredState", async () => {
    const result = await preflightGuardNode(
      makeState({
        resourceType: "AWS::Lambda::Function",
        desiredState: { MemorySize: 512 },
      }),
    );
    // 512MB: duration cost = 1M × 0.1s × (512/1024) × $0.0000166667 = $0.833335
    // Total = $0.20 + $0.833335 ≈ $1.03
    expect(result.estimatedMonthlyCost).toMatch(/^~\$1\.03\/million req/);
    expect(result.estimatedMonthlyCost).toContain("512MB");
  });

  it("parses real get_pricing MCP response and returns first-tier price", async () => {
    // Real response shape returned by awslabs.aws-pricing-mcp-server get_pricing tool.
    // Captured from a live call: AmazonS3, region us-east-1, filtered to TimedStorage-ByteHrs.
    const realMcpResponse = {
      type: "text",
      text: JSON.stringify({
        status: "success",
        service_name: "AmazonS3",
        data: [
          {
            product: {
              productFamily: "Storage",
              attributes: {
                usagetype: "TimedStorage-ByteHrs",
                regionCode: "us-east-1",
              },
              sku: "4NA7Y494T4JAZ9A",
            },
            terms: {
              OnDemand: {
                "4NA7Y494T4JAZ9A.JRTCKXETXF": {
                  priceDimensions: {
                    "4NA7Y494T4JAZ9A.JRTCKXETXF.6YS6EN2CT7": {
                      beginRange: "0",
                      endRange: "51200",
                      pricePerUnit: { USD: "0.0230000000" },
                      description:
                        "$0.023 per GB - first 50 TB / month of storage used",
                      unit: "GB-Mo",
                    },
                    "4NA7Y494T4JAZ9A.JRTCKXETXF.SW9GXFZZ3P": {
                      beginRange: "51200",
                      endRange: "512000",
                      pricePerUnit: { USD: "0.0220000000" },
                      description:
                        "$0.022 per GB - next 450 TB / month of storage used",
                      unit: "GB-Mo",
                    },
                    "4NA7Y494T4JAZ9A.JRTCKXETXF.7YB3XKGZP3": {
                      beginRange: "512000",
                      endRange: "Inf",
                      pricePerUnit: { USD: "0.0210000000" },
                      description:
                        "$0.021 per GB - storage used / month over 500 TB",
                      unit: "GB-Mo",
                    },
                  },
                },
              },
            },
          },
        ],
      }),
    };

    const pricingTool = {
      name: "get_pricing",
      invoke: vi.fn().mockResolvedValue(realMcpResponse),
    } as unknown as StructuredTool;

    const result = await preflightGuardNode(makeState(), [pricingTool]);

    expect(result.estimatedMonthlyCost).toBe(`$0.0230${PricingUnit.GB_MONTH}`);
    expect(result.preflightPassed).toBe(true);
    expect(pricingTool.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ service_code: "AmazonS3" }),
    );
  });
});
