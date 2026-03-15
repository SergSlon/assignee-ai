import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionStatus } from "@assignee/core";
import { preflightGuardNode } from "./preflight-guard.js";
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
    expect(result.estimatedMonthlyCost).toBe("Free");
    expect(pricingTool.invoke).not.toHaveBeenCalled();
  });

  it("returns N/A when no pricing tool is available", async () => {
    const result = await preflightGuardNode(makeState(), []);
    expect(result.estimatedMonthlyCost).toBe("N/A");
  });

  it("skips when executionStatus is already FAILED", async () => {
    const result = await preflightGuardNode(
      makeState({ executionStatus: ExecutionStatus.FAILED }),
    );
    expect(result).toEqual({});
  });

  it("returns N/A on pricing timeout (non-blocking)", async () => {
    const slowTool = {
      name: "aws_pricing_get_price",
      invoke: vi.fn(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ estimatedMonthlyCost: "$5" }), 2000),
          ),
      ),
    } as unknown as StructuredTool;

    const result = await preflightGuardNode(makeState(), [slowTool]);
    // Pricing timed out → N/A, preflightPassed still true
    expect(result.preflightPassed).toBe(true);
    expect(result.estimatedMonthlyCost).toBe("N/A");
  }, 3000);
});
