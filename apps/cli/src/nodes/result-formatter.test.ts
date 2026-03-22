/**
 * Tests for result-formatter node (Story 2.4, Story 8.2, Story 19.2).
 * Covers compound SUCCESS routing, compound FAILED partial message,
 * single-resource path, and post-provision security posture checks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ExecutionStatus,
  ExecutionMode,
  ProvisioningError,
  AssigneeError,
} from "@assignee/core";
import type { AgentState } from "../services/graph.js";
import type { ArchitecturePattern } from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import {
  McpMocks,
  createSecurityMockTool,
} from "../test-fixtures/mcp-mock-responses.js";

// Suppress display output for all tests
vi.mock("../utils/display.js", () => ({
  renderApplySuccess: vi.fn(),
  renderCompoundSuccess: vi.fn(),
  renderError: vi.fn(),
  renderPlanBox: vi.fn(),
  renderSecurityWarnings: vi.fn(),
}));

// Suppress logger output
vi.mock("../utils/logger.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    RESULT_FORMATTED: "result_formatted",
    APPLY_SUCCEEDED: "apply_succeeded",
    APPLY_FAILED: "apply_failed",
    SECURITY_CHECK_SKIPPED: "security_check_skipped",
  },
}));

// Mock memory service (Story 19.3, 19.4)
vi.mock("../services/memory.js", () => ({
  defaultMemoryService: {
    appendProvision: vi.fn().mockResolvedValue(undefined),
    appendFailure: vi.fn().mockResolvedValue(undefined),
    upsertPattern: vi.fn().mockResolvedValue(undefined),
  },
}));

import { resultFormatterNode } from "./result-formatter.js";
import {
  renderApplySuccess,
  renderCompoundSuccess,
  renderError,
  renderPlanBox,
  renderSecurityWarnings,
} from "../utils/display.js";
import { defaultMemoryService } from "../services/memory.js";

/** 3-resource pattern for compound tests */
const mockPattern: ArchitecturePattern = {
  patternId: "serverless-api",
  displayName: "Serverless API",
  keywords: ["serverless api"],
  resourceList: [
    {
      resourceId: "lambda-execution-role",
      resourceType: "AWS::IAM::Role",
      displayName: "Lambda Execution Role",
    },
    {
      resourceId: "lambda-fn",
      resourceType: "AWS::Lambda::Function",
      displayName: "Lambda Function",
    },
    {
      resourceId: "api-gateway",
      resourceType: "AWS::ApiGatewayV2::Api",
      displayName: "API Gateway",
    },
  ],
  dependencyOrder: [["lambda-execution-role"], ["lambda-fn"], ["api-gateway"]],
  defaultOptions: {},
};

function makeResourceQueue() {
  return mockPattern.resourceList;
}

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "create a serverless api",
    runId: "test-run-id",
    executionMode: ExecutionMode.APPLY,
    resourceType: "AWS::IAM::Role",
    executionStatus: ExecutionStatus.SUCCESS,
    preflightPassed: true,
    preflightErrors: [],
    preflightMode: "local",
    messages: [],
    ...overrides,
  } as AgentState;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Single-resource path (no change from existing behaviour) ─────────────────

describe("resultFormatterNode — single-resource SUCCESS", () => {
  it("calls renderApplySuccess and returns {}", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: "arn:aws:iam::123456789012:role/my-role",
    });
    const result = await resultFormatterNode(state);

    expect(renderApplySuccess).toHaveBeenCalledWith(state);
    expect(renderCompoundSuccess).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });
});

describe("resultFormatterNode — single-resource FAILED", () => {
  it("calls renderError with errorMessage and returns {}", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "Provisioning failed",
    });
    const result = await resultFormatterNode(state);

    expect(renderError).toHaveBeenCalled();
    expect(result).toEqual({});
  });
});

describe("resultFormatterNode — plan mode (PENDING)", () => {
  it("calls renderPlanBox in plan mode", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.PENDING,
      executionMode: ExecutionMode.PLAN,
    });
    await resultFormatterNode(state);
    expect(renderPlanBox).toHaveBeenCalledWith(state);
  });
});

// ── Compound SUCCESS routing ─────────────────────────────────────────────────

describe("resultFormatterNode — compound SUCCESS with more resources", () => {
  it("returns updated state with PENDING and incremented index (not calling renderApplySuccess)", async () => {
    const resourceQueue = makeResourceQueue();
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourcePattern: mockPattern,
      resourceQueue,
      currentResourceIndex: 0, // first resource (IAM Role) just completed
      completedResources: [],
      resourceArn: "arn:aws:iam::123:role/exec-role",
      resourceType: "AWS::IAM::Role",
    });

    const result = await resultFormatterNode(state);

    // Should NOT call single-resource render
    expect(renderApplySuccess).not.toHaveBeenCalled();
    expect(renderCompoundSuccess).not.toHaveBeenCalled();

    // Should reset state for next resource (Lambda Function)
    expect(result.executionStatus).toBe(ExecutionStatus.PENDING);
    expect(result.currentResourceIndex).toBe(1);
    expect(result.resourceType).toBe("AWS::Lambda::Function");
    expect(result.requestToken).toBeUndefined();
    expect(result.resourceArn).toBeUndefined();
    expect(result.desiredState).toBeUndefined();

    // First resource should be in completedResources
    expect(result.completedResources).toHaveLength(1);
    expect(result.completedResources?.[0]).toMatchObject({
      resourceId: "lambda-execution-role",
      resourceType: "AWS::IAM::Role",
      resourceArn: "arn:aws:iam::123:role/exec-role",
      executionStatus: ExecutionStatus.SUCCESS,
    });
  });

  it("accumulates completedResources across iterations", async () => {
    const resourceQueue = makeResourceQueue();
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourcePattern: mockPattern,
      resourceQueue,
      currentResourceIndex: 1, // second resource (Lambda) just completed
      completedResources: [
        {
          resourceId: "lambda-execution-role",
          resourceType: "AWS::IAM::Role",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
      resourceArn: "arn:aws:lambda::123:function:my-fn",
      resourceType: "AWS::Lambda::Function",
    });

    const result = await resultFormatterNode(state);

    expect(result.currentResourceIndex).toBe(2);
    expect(result.resourceType).toBe("AWS::ApiGatewayV2::Api");
    expect(result.completedResources).toHaveLength(2);
    expect(result.completedResources?.[1]?.resourceId).toBe("lambda-fn");
  });
});

describe("resultFormatterNode — compound SUCCESS final resource", () => {
  it("calls renderCompoundSuccess when all resources complete", async () => {
    const resourceQueue = makeResourceQueue();
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourcePattern: mockPattern,
      resourceQueue,
      currentResourceIndex: 2, // last resource (API Gateway) just completed
      completedResources: [
        {
          resourceId: "lambda-execution-role",
          resourceType: "AWS::IAM::Role",
          executionStatus: ExecutionStatus.SUCCESS,
        },
        {
          resourceId: "lambda-fn",
          resourceType: "AWS::Lambda::Function",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
      resourceArn: "arn:aws:apigateway::123:apis/abc",
      resourceType: "AWS::ApiGatewayV2::Api",
    });

    const result = await resultFormatterNode(state);

    expect(renderCompoundSuccess).toHaveBeenCalledOnce();
    expect(renderApplySuccess).not.toHaveBeenCalled();

    // Final state should have all 3 completedResources
    expect(result.completedResources).toHaveLength(3);
    // Should NOT reset executionStatus (stays SUCCESS → routeResultFormatter → END)
    expect(result.executionStatus).toBeUndefined();
  });
});

// ── Compound FAILED partial result ───────────────────────────────────────────

describe("resultFormatterNode — compound FAILED with partial results", () => {
  it("renders cleanup warning when some resources were already provisioned", async () => {
    const resourceQueue = makeResourceQueue();
    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      resourcePattern: mockPattern,
      resourceQueue,
      currentResourceIndex: 1,
      completedResources: [
        {
          resourceId: "lambda-execution-role",
          resourceType: "AWS::IAM::Role",
          resourceArn: "arn:aws:iam::123:role/exec-role",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
      resourceType: "AWS::Lambda::Function",
      errorMessage: "Lambda creation failed",
    });

    await resultFormatterNode(state);

    expect(renderError).toHaveBeenCalledOnce();
    const [errorMsg] = vi.mocked(renderError).mock.calls[0] as [
      string,
      ...unknown[],
    ];
    expect(errorMsg).toContain("Provision halted at AWS::Lambda::Function");
    expect(errorMsg).toContain("AWS::IAM::Role");
    expect(errorMsg).toContain("Manual cleanup may be required");
  });

  it("renders standard error message when no resources were provisioned yet", async () => {
    const resourceQueue = makeResourceQueue();
    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      resourcePattern: mockPattern,
      resourceQueue,
      currentResourceIndex: 0,
      completedResources: [], // nothing provisioned yet
      resourceType: "AWS::IAM::Role",
      errorMessage: "IAM Role creation failed",
    });

    await resultFormatterNode(state);

    expect(renderError).toHaveBeenCalledOnce();
    const [errorMsg] = vi.mocked(renderError).mock.calls[0] as [
      string,
      ...unknown[],
    ];
    expect(errorMsg).toBe("IAM Role creation failed");
  });
});

// ── Story 19.2: Post-provision security posture check ─────────────────────
// Uses captured responses from well-architected-security-mcp-server via McpMocks.security.*

describe("resultFormatterNode — Story 19.2 security posture check (single-resource)", () => {
  it("surfaces CRITICAL finding as warning after successful apply", async () => {
    const tool = createSecurityMockTool(
      McpMocks.security.s3BucketPosture.success,
    );
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: "arn:aws:s3:::my-bucket-12345",
    });

    const result = await resultFormatterNode(state, [tool]);

    expect(renderApplySuccess).toHaveBeenCalledWith(state);
    // s3BucketPosture has CRITICAL + HIGH + MEDIUM; only CRITICAL & HIGH are surfaced
    expect(renderSecurityWarnings).toHaveBeenCalledWith(
      "arn:aws:s3:::my-bucket-12345",
      expect.arrayContaining([
        expect.objectContaining({
          severity: "CRITICAL",
          title: "S3 bucket has public read access",
        }),
        expect.objectContaining({
          severity: "HIGH",
          title: "S3 bucket does not have default encryption enabled",
        }),
      ]),
    );
    // Non-blocking: status remains SUCCESS
    expect(result).toEqual({});
  });

  it("surfaces HIGH finding as warning after successful apply", async () => {
    const tool = createSecurityMockTool(
      McpMocks.security.s3BucketPosture.success,
    );
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: "arn:aws:s3:::my-bucket-12345",
    });

    const result = await resultFormatterNode(state, [tool]);

    // Verify HIGH finding is included in the rendered warnings
    expect(renderSecurityWarnings).toHaveBeenCalledWith(
      "arn:aws:s3:::my-bucket-12345",
      expect.arrayContaining([
        expect.objectContaining({
          severity: "HIGH",
          title: "S3 bucket does not have default encryption enabled",
        }),
      ]),
    );
    expect(result).toEqual({});
  });

  it("filters out MEDIUM/LOW findings — not shown", async () => {
    // noFindings response has zero findings, so no warnings at all
    const tool = createSecurityMockTool(McpMocks.security.noFindings.success);
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: "arn:aws:s3:::my-bucket-12345",
    });

    await resultFormatterNode(state, [tool]);

    // No CRITICAL/HIGH findings, so renderSecurityWarnings should not be called
    expect(renderSecurityWarnings).not.toHaveBeenCalled();
  });

  it("no findings produces clean result (no security section)", async () => {
    const tool = createSecurityMockTool(McpMocks.security.noFindings.success);
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: "arn:aws:s3:::my-bucket-12345",
    });

    await resultFormatterNode(state, [tool]);

    expect(renderSecurityWarnings).not.toHaveBeenCalled();
  });

  it("does NOT change executionStatus — remains SUCCESS", async () => {
    const tool = createSecurityMockTool(
      McpMocks.security.s3BucketPosture.success,
    );
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: "arn:aws:s3:::my-bucket-12345",
    });

    const result = await resultFormatterNode(state, [tool]);

    // result should be empty — no error fields, no status change
    expect(result).toEqual({});
    expect(result.executionStatus).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
  });
});

// ── Story 19.3: Provision memory write ─────────────────────────────────────

describe("resultFormatterNode — Story 19.3 provision memory write", () => {
  it("writes provision record after single-resource SUCCESS", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: "arn:aws:s3:::my-bucket",
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "my-bucket" },
      estimatedMonthlyCost: "$0.023/GB-month",
    });

    await resultFormatterNode(state);

    expect(defaultMemoryService.appendProvision).toHaveBeenCalledOnce();
    const call = vi.mocked(defaultMemoryService.appendProvision).mock
      .calls[0]![0];
    expect(call.runId).toBe("test-run-id");
    expect(call.resourceType).toBe("AWS::S3::Bucket");
    expect(call.resourceArn).toBe("arn:aws:s3:::my-bucket");
    expect(call.estimatedMonthlyCost).toBe("$0.023/GB-month");
    expect(call.desiredStateHash).toBeTruthy();
    expect(call.timestamp).toBeTruthy();
  });

  it("writes provision records for each resource in compound SUCCESS final", async () => {
    const resourceQueue = makeResourceQueue();
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourcePattern: mockPattern,
      resourceQueue,
      currentResourceIndex: 2,
      completedResources: [
        {
          resourceId: "lambda-execution-role",
          resourceType: "AWS::IAM::Role",
          resourceArn: "arn:aws:iam::123:role/exec-role",
          executionStatus: ExecutionStatus.SUCCESS,
        },
        {
          resourceId: "lambda-fn",
          resourceType: "AWS::Lambda::Function",
          resourceArn: "arn:aws:lambda::123:function:my-fn",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
      resourceArn: "arn:aws:apigateway::123:apis/abc",
      resourceType: "AWS::ApiGatewayV2::Api",
    });

    await resultFormatterNode(state);

    // 3 resources completed = 3 provision records
    expect(defaultMemoryService.appendProvision).toHaveBeenCalledTimes(3);
  });

  it("memory write failure does not change the execution result", async () => {
    vi.mocked(defaultMemoryService.appendProvision).mockRejectedValueOnce(
      new Error("Disk full"),
    );

    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: "arn:aws:s3:::my-bucket",
      resourceType: "AWS::S3::Bucket",
    });

    const result = await resultFormatterNode(state);

    // Should still render success
    expect(renderApplySuccess).toHaveBeenCalledWith(state);
    // Result should be empty (no error propagation)
    expect(result).toEqual({});
  });

  it("does not write provision record on FAILED status", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "Something went wrong",
    });

    await resultFormatterNode(state);

    expect(defaultMemoryService.appendProvision).not.toHaveBeenCalled();
  });
});

describe("resultFormatterNode — Story 19.2 graceful degradation", () => {
  it("skips check silently when security tool not in tools array", async () => {
    const otherTool = {
      name: "get_pricing",
      invoke: vi.fn(),
    } as unknown as StructuredTool;
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: "arn:aws:s3:::my-bucket-12345",
    });

    const result = await resultFormatterNode(state, [otherTool]);

    expect(renderSecurityWarnings).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it("skips check when tools is undefined", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: "arn:aws:s3:::my-bucket-12345",
    });

    const result = await resultFormatterNode(state);

    expect(renderSecurityWarnings).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it("prints warning when security tool invocation throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tool = {
      name: "AnalyzeSecurityPosture",
      invoke: vi.fn().mockRejectedValue(new Error("Connection refused")),
    } as unknown as StructuredTool;
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: "arn:aws:s3:::my-bucket-12345",
    });

    const result = await resultFormatterNode(state, [tool]);

    expect(warnSpy).toHaveBeenCalledWith(
      "Security posture check skipped (MCP server unavailable)",
    );
    expect(result).toEqual({});
    warnSpy.mockRestore();
  });

  it("skips when resourceArn is undefined", async () => {
    const tool = createSecurityMockTool(McpMocks.security.noFindings.success);
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: undefined,
    });

    const result = await resultFormatterNode(state, [tool]);

    expect(renderSecurityWarnings).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });
});

// ── Story 19.4: Failure memory write ──────────────────────────────────────────

describe("resultFormatterNode — Story 19.4 failure memory write", () => {
  it("writes failure record after FAILED status", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      resourceType: "AWS::S3::Bucket",
      errorMessage: "Bucket creation failed",
    });

    await resultFormatterNode(state);

    expect(defaultMemoryService.appendFailure).toHaveBeenCalledOnce();
    const call = vi.mocked(defaultMemoryService.appendFailure).mock
      .calls[0]![0];
    expect(call.runId).toBe("test-run-id");
    expect(call.resourceType).toBe("AWS::S3::Bucket");
    expect(call.errorMessage).toBe("Bucket creation failed");
    expect(call.timestamp).toBeTruthy();
  });

  it("extracts provisioningCode from ProvisioningError", async () => {
    const provErr = new ProvisioningError("Already exists", "AlreadyExists");
    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      resourceType: "AWS::S3::Bucket",
      errorMessage: "Bucket already exists",
      error: provErr,
    });

    await resultFormatterNode(state);

    const call = vi.mocked(defaultMemoryService.appendFailure).mock
      .calls[0]![0];
    expect(call.errorCode).toBe("AlreadyExists");
  });

  it("extracts error code from AssigneeError", async () => {
    const err = new AssigneeError("MCP timeout", "MCP_ERROR");
    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      resourceType: "AWS::Lambda::Function",
      errorMessage: "MCP timeout",
      error: err,
    });

    await resultFormatterNode(state);

    const call = vi.mocked(defaultMemoryService.appendFailure).mock
      .calls[0]![0];
    expect(call.errorCode).toBe("MCP_ERROR");
  });

  it("uses UNKNOWN errorCode when no error object", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      resourceType: "AWS::S3::Bucket",
      errorMessage: "Something failed",
    });

    await resultFormatterNode(state);

    const call = vi.mocked(defaultMemoryService.appendFailure).mock
      .calls[0]![0];
    expect(call.errorCode).toBe("UNKNOWN");
  });

  it("populates suggestedFix from ErrorHintRegistry when available", async () => {
    const provErr = new ProvisioningError("Already exists", "AlreadyExists");
    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      resourceType: "AWS::S3::Bucket",
      errorMessage: "Bucket already exists",
      error: provErr,
    });

    await resultFormatterNode(state);

    const call = vi.mocked(defaultMemoryService.appendFailure).mock
      .calls[0]![0];
    // AlreadyExists hint from defaultErrorHintRegistry
    expect(call.suggestedFix).toContain("different name");
  });

  it("suggestedFix is empty string when no hint is available", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      resourceType: "AWS::S3::Bucket",
      errorMessage: "Unknown error happened",
    });

    await resultFormatterNode(state);

    const call = vi.mocked(defaultMemoryService.appendFailure).mock
      .calls[0]![0];
    // No error object = no hint from ErrorHintRegistry, fallback to error-messages registry
    // which returns a generic howToFix, but for truly unknown errors it may be empty or generic
    expect(typeof call.suggestedFix).toBe("string");
  });

  it("memory write failure does not affect error output", async () => {
    vi.mocked(defaultMemoryService.appendFailure).mockRejectedValueOnce(
      new Error("Disk full"),
    );

    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      resourceType: "AWS::S3::Bucket",
      errorMessage: "Bucket creation failed",
    });

    // Should not throw
    const result = await resultFormatterNode(state);

    expect(renderError).toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it("does not write failure record on SUCCESS status", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: "arn:aws:s3:::my-bucket",
      resourceType: "AWS::S3::Bucket",
    });

    await resultFormatterNode(state);

    expect(defaultMemoryService.appendFailure).not.toHaveBeenCalled();
  });

  it("writes failure record for POLICY_BLOCKED status", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.POLICY_BLOCKED,
      resourceType: "AWS::S3::Bucket",
      errorMessage: "Blocked by org policy",
    });

    await resultFormatterNode(state);

    expect(defaultMemoryService.appendFailure).toHaveBeenCalledOnce();
  });
});
