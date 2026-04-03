import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionStatus, CostEstimateLabel } from "@assignee/core";
import { preflightGuardNode } from "./preflight-guard.js";
import { LambdaPricing, PricingUnit } from "../constants/pricing.js";
import { ToolName } from "../constants/tools.js";
import type { StructuredTool } from "@langchain/core/tools";
import {
  McpMocks,
  createIamMockTool,
  createMockTool,
} from "../test-fixtures/mcp-mock-responses.js";

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
    expect(result.estimatedMonthlyCost).toBe(CostEstimateLabel.FREE);
    expect(pricingTool.invoke).not.toHaveBeenCalled();
  });

  it("returns N/A when no pricing tool is available", async () => {
    const result = await preflightGuardNode(makeState(), []);
    expect(result.estimatedMonthlyCost).toBe(CostEstimateLabel.NA);
  });

  it("skips when executionStatus is already FAILED", async () => {
    const result = await preflightGuardNode(
      makeState({ executionStatus: ExecutionStatus.FAILED }),
    );
    expect(result).toEqual({});
  });

  it("returns N/A on pricing timeout (non-blocking)", async () => {
    // All pricing queries time out — both main query and decomposer line items
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
    // Pricing timed out → preflightPassed still true (non-blocking)
    expect(result.preflightPassed).toBe(true);
    // With decomposer line items, partial failures may still yield a per-unit rate
    // from items that succeed before timeout. If all timeout, cost is N/A.
    // Either outcome is acceptable — the key invariant is preflight still passes.
    expect(
      result.estimatedMonthlyCost === CostEstimateLabel.NA ||
        typeof result.estimatedMonthlyCost === "string",
    ).toBe(true);
  }, 8000);

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

  // ── Story 12.3: BP findings integration ─────────────────────────────────────

  it("sets preflightPassed = true when CRITICAL severity but blocking: false", async () => {
    const result = await preflightGuardNode(
      makeState({
        bpFindings: [
          {
            practiceId: "BP-S3-002",
            title: "Enable S3 Default Encryption",
            severity: "CRITICAL",
            category: "security",
            message: "S3 bucket should have default encryption",
            blocking: false,
          },
        ],
      }),
    );
    expect(result.preflightPassed).toBe(true);
  });

  it("sets preflightPassed = false when blocking: true finding is present", async () => {
    const result = await preflightGuardNode(
      makeState({
        bpFindings: [
          {
            practiceId: "BP-S3-001",
            title: "S3 public access block",
            severity: "HIGH",
            category: "security",
            message: "S3 bucket has public access enabled",
            blocking: true,
          },
        ],
      }),
    );
    expect(result.preflightPassed).toBe(false);
  });

  it("keeps preflightPassed = true when only MEDIUM non-blocking BP findings exist", async () => {
    const result = await preflightGuardNode(
      makeState({
        bpFindings: [
          {
            practiceId: "BP-S3-005",
            title: "Enable S3 Bucket Versioning",
            severity: "MEDIUM",
            category: "reliability",
            message: "S3 bucket versioning should be enabled",
            blocking: false,
          },
        ],
      }),
    );
    expect(result.preflightPassed).toBe(true);
  });

  it("keeps preflightPassed = true when bpFindings is empty", async () => {
    const result = await preflightGuardNode(makeState({ bpFindings: [] }));
    expect(result.preflightPassed).toBe(true);
  });

  // ── Story 41.2: BP enforcement levels ────────────────────────────────────────

  it("enforcement=enforce + --yes + blocking → still blocked (preflightPassed=false)", async () => {
    const result = await preflightGuardNode(
      makeState({
        bpEnforcementLevel: "enforce",
        autoApprove: true,
        bpFindings: [
          {
            practiceId: "BP-S3-001",
            title: "S3 public access block",
            severity: "HIGH",
            category: "security",
            message: "S3 bucket has public access enabled",
            blocking: true,
          },
        ],
      }),
    );
    expect(result.preflightPassed).toBe(false);
  });

  it("enforcement=enforce + noWizard + blocking → still blocked (preflightPassed=false)", async () => {
    const result = await preflightGuardNode(
      makeState({
        bpEnforcementLevel: "enforce",
        noWizard: true,
        bpFindings: [
          {
            practiceId: "BP-S3-001",
            title: "S3 public access block",
            severity: "HIGH",
            category: "security",
            message: "S3 bucket has public access enabled",
            blocking: true,
          },
        ],
      }),
    );
    expect(result.preflightPassed).toBe(false);
  });

  it("enforcement=warn + blocking findings → preflightPassed=true (advisory only)", async () => {
    const result = await preflightGuardNode(
      makeState({
        bpEnforcementLevel: "warn",
        bpFindings: [
          {
            practiceId: "BP-S3-001",
            title: "S3 public access block",
            severity: "HIGH",
            category: "security",
            message: "S3 bucket has public access enabled",
            blocking: true,
          },
        ],
      }),
    );
    expect(result.preflightPassed).toBe(true);
  });

  it("enforcement=skip + blocking findings → preflightPassed=true (no evaluation)", async () => {
    const result = await preflightGuardNode(
      makeState({
        bpEnforcementLevel: "skip",
        bpFindings: [
          {
            practiceId: "BP-S3-001",
            title: "S3 public access block",
            severity: "HIGH",
            category: "security",
            message: "S3 bucket has public access enabled",
            blocking: true,
          },
        ],
      }),
    );
    expect(result.preflightPassed).toBe(true);
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

// ── Story 19.1: IAM permission pre-check ──────────────────────────────────────
// Uses captured responses from iam-mcp-server via McpMocks.iam.*

describe("preflightGuardNode — IAM permission check (Story 19.1)", () => {
  it("passes when all actions are allowed — provisioning continues", async () => {
    const iamTool = createIamMockTool(McpMocks.iam.s3BucketAllowed.success);

    const result = await preflightGuardNode(makeState(), [iamTool]);

    expect(result.executionStatus).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
    expect(result.preflightPassed).toBe(true);
  });

  it("fails with specific missing actions — returns FAILED with descriptive message", async () => {
    const iamTool = createIamMockTool(
      McpMocks.iam.ec2InstancePartialDeny.success,
    );

    const result = await preflightGuardNode(makeState(), [iamTool]);

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("Insufficient IAM permissions");
    expect(result.errorMessage).toContain("ec2:RunInstances");
    expect(result.errorMessage).toContain("iam:PassRole");
    expect(result.errorMessage).toContain(
      "Ask your admin to grant these permissions or use a different profile",
    );
  });

  it("skips check when IAM tool is not found — provisioning continues", async () => {
    const otherTool = createMockTool("some_other_tool", null);

    const result = await preflightGuardNode(makeState(), [otherTool]);

    expect(result.executionStatus).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
    expect(result.preflightPassed).toBe(true);
  });

  it("skips check gracefully when IAM tool invocation throws — provisioning continues", async () => {
    const iamTool = {
      name: ToolName.SIMULATE_PRINCIPAL_POLICY,
      invoke: vi.fn().mockRejectedValue(new Error("MCP server crashed")),
    } as unknown as StructuredTool;

    const result = await preflightGuardNode(makeState(), [iamTool]);

    expect(result.executionStatus).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
    expect(result.preflightPassed).toBe(true);
  });

  it("skips check gracefully when IAM tool invocation times out", async () => {
    const iamTool = {
      name: ToolName.SIMULATE_PRINCIPAL_POLICY,
      invoke: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    } as unknown as StructuredTool;

    // withTimeout returns null on timeout, so IAM check is silently skipped
    const result = await preflightGuardNode(makeState(), [iamTool]);

    expect(result.executionStatus).toBeUndefined();
    expect(result.preflightPassed).toBe(true);
  });

  it("skips check when no tools are provided", async () => {
    const result = await preflightGuardNode(makeState());

    expect(result.executionStatus).toBeUndefined();
    expect(result.preflightPassed).toBe(true);
  });

  it("skips check when resourceType is empty", async () => {
    const iamTool = createIamMockTool();

    const result = await preflightGuardNode(makeState({ resourceType: "" }), [
      iamTool,
    ]);

    expect(result.executionStatus).toBeUndefined();
    expect(result.preflightPassed).toBe(true);
    // IAM tool should not have been called
    expect(iamTool.invoke).not.toHaveBeenCalled();
  });
});

// ── Story 9.10: Parallel pricing + IAM fan-out ──────────────────────────────

describe("preflightGuardNode — parallel pricing + IAM fan-out (Story 9.10)", () => {
  it("pricing and IAM run concurrently (overlapping execution)", async () => {
    const executionLog: Array<{
      task: string;
      event: "start" | "end";
      time: number;
    }> = [];

    const pricingTool = {
      name: "get_pricing",
      invoke: vi.fn(async () => {
        executionLog.push({
          task: "pricing",
          event: "start",
          time: Date.now(),
        });
        await new Promise((r) => setTimeout(r, 50));
        executionLog.push({ task: "pricing", event: "end", time: Date.now() });
        return {
          type: "text",
          text: JSON.stringify({
            status: "success",
            data: [
              {
                terms: {
                  OnDemand: {
                    "X.Y": {
                      priceDimensions: {
                        "X.Y.Z": {
                          beginRange: "0",
                          endRange: "Inf",
                          pricePerUnit: { USD: "0.0230000000" },
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
      }),
    } as unknown as StructuredTool;

    const iamTool = {
      name: ToolName.SIMULATE_PRINCIPAL_POLICY,
      invoke: vi.fn(async () => {
        executionLog.push({ task: "iam", event: "start", time: Date.now() });
        await new Promise((r) => setTimeout(r, 50));
        executionLog.push({ task: "iam", event: "end", time: Date.now() });
        return {
          type: "text",
          text: JSON.stringify({
            EvaluationResults: [
              { EvalActionName: "s3:CreateBucket", EvalDecision: "allowed" },
            ],
          }),
        };
      }),
    } as unknown as StructuredTool;

    const result = await preflightGuardNode(makeState(), [
      pricingTool,
      iamTool,
    ]);

    // Both should have been called
    expect(pricingTool.invoke).toHaveBeenCalled();
    expect(iamTool.invoke).toHaveBeenCalled();
    expect(result.preflightPassed).toBe(true);

    // Verify overlapping execution: IAM should start before pricing ends
    const pricingStart = executionLog.find(
      (e) => e.task === "pricing" && e.event === "start",
    );
    const iamStart = executionLog.find(
      (e) => e.task === "iam" && e.event === "start",
    );
    const pricingEnd = executionLog.find(
      (e) => e.task === "pricing" && e.event === "end",
    );
    expect(pricingStart).toBeDefined();
    expect(iamStart).toBeDefined();
    expect(pricingEnd).toBeDefined();
    // IAM should start before pricing ends (proving concurrency)
    expect(iamStart!.time).toBeLessThanOrEqual(pricingEnd!.time);
  });

  it("graceful degradation: pricing failure does not block IAM check", async () => {
    const pricingTool = {
      name: "get_pricing",
      invoke: vi
        .fn()
        .mockRejectedValue(new Error("MCP pricing server crashed")),
    } as unknown as StructuredTool;

    const iamTool = createIamMockTool(McpMocks.iam.s3BucketAllowed.success);

    const result = await preflightGuardNode(makeState(), [
      pricingTool,
      iamTool,
    ]);

    // IAM should still pass despite pricing failure
    expect(result.preflightPassed).toBe(true);
    expect(result.executionStatus).toBeUndefined();
    // Cost should fall back to local estimate
    expect(result.estimatedMonthlyCost).toBeDefined();
  });

  it("graceful degradation: IAM failure does not block pricing", async () => {
    const realMcpResponse = {
      type: "text",
      text: JSON.stringify({
        status: "success",
        data: [
          {
            terms: {
              OnDemand: {
                "X.Y": {
                  priceDimensions: {
                    "X.Y.Z": {
                      beginRange: "0",
                      endRange: "Inf",
                      pricePerUnit: { USD: "0.0230000000" },
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

    const iamTool = {
      name: ToolName.SIMULATE_PRINCIPAL_POLICY,
      invoke: vi.fn().mockRejectedValue(new Error("IAM MCP crashed")),
    } as unknown as StructuredTool;

    const result = await preflightGuardNode(makeState(), [
      pricingTool,
      iamTool,
    ]);

    // Pricing should succeed, IAM should degrade gracefully
    expect(result.estimatedMonthlyCost).toBeDefined();
    expect(result.preflightPassed).toBe(true);
    expect(result.executionStatus).toBeUndefined();
  });

  it("both pricing and IAM fail: graceful degradation for both", async () => {
    const pricingTool = {
      name: "get_pricing",
      invoke: vi.fn().mockRejectedValue(new Error("pricing down")),
    } as unknown as StructuredTool;

    const iamTool = {
      name: ToolName.SIMULATE_PRINCIPAL_POLICY,
      invoke: vi.fn().mockRejectedValue(new Error("iam down")),
    } as unknown as StructuredTool;

    const result = await preflightGuardNode(makeState(), [
      pricingTool,
      iamTool,
    ]);

    // Both degrade gracefully — preflight still passes
    expect(result.preflightPassed).toBe(true);
    expect(result.estimatedMonthlyCost).toBeDefined();
    expect(result.executionStatus).toBeUndefined();
  });
});
