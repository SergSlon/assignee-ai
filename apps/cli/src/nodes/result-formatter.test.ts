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

// Mock @clack/prompts spinner (used by Story 37.4 upload flow).
// NOTE: Plain functions for spinner/isCancel survive mockReset:true.
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  spinner: () => ({
    start: () => undefined,
    stop: () => undefined,
    message: () => undefined,
  }),
  select: vi.fn(),
  confirm: vi.fn(),
  isCancel: () => false,
  multiselect: vi.fn(),
}));

// Mock s3-upload service (Story 37.4). Default impls re-installed in beforeEach.
vi.mock("../services/s3-upload.js", () => ({
  uploadStaticSite: vi.fn(),
  configureBucketPolicy: vi.fn(),
}));

// Mock cloudfront-setup service (Epic 37 — CloudFront distribution).
// Default impls re-installed in beforeEach.
vi.mock("../services/cloudfront-setup.js", () => ({
  createCloudFrontDistribution: vi.fn(),
  generateCloudFrontBucketPolicy: vi.fn(),
}));

// result-formatter.ts now uses requireAssigneeCredentials("operator") from
// the centralized helper instead of the legacy operator-credentials shim.
// Provide realistic-shaped operator env vars in beforeEach so the dynamic
// import in the CloudFront path can construct the S3Client. Tests verifying
// fail-closed behavior delete the env vars within their own beforeEach.

// Mock @aws-sdk/client-s3 PutBucketPolicyCommand (used for OAC policy).
// Plain class survives mockReset:true.
vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    async send() {
      return {};
    }
  }
  return {
    S3Client,
    PutBucketPolicyCommand: vi.fn(),
  };
});

// Suppress display output for all tests. Default impls re-installed in beforeEach.
vi.mock("../utils/display.js", () => ({
  renderApplySuccess: vi.fn(),
  renderCompoundSuccess: vi.fn(),
  renderError: vi.fn(),
  renderPlanBox: vi.fn(),
  renderSecurityWarnings: vi.fn(),
  promptFixSelection: vi.fn(),
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

// Mock memory service (Story 19.3, 19.4, 20.13). Default impls re-installed
// in beforeEach because mockReset:true wipes vi.fn implementations.
vi.mock("../services/memory.js", () => ({
  defaultMemoryService: {
    appendProvision: vi.fn(),
    appendFailure: vi.fn(),
    upsertPattern: vi.fn(),
    clearFailuresForType: vi.fn(),
  },
}));

import { resultFormatterNode } from "./result-formatter.js";
import {
  renderApplySuccess,
  renderCompoundSuccess,
  renderError,
  renderPlanBox,
  renderSecurityWarnings,
  promptFixSelection,
  type FixSelectionResult,
} from "../utils/display.js";
import { defaultMemoryService } from "../services/memory.js";
import {
  uploadStaticSite,
  configureBucketPolicy,
} from "../services/s3-upload.js";
import { createCloudFrontDistribution } from "../services/cloudfront-setup.js";

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

// Snapshot env so per-test credential mutations don't leak between cases
const RESULT_FORMATTER_ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  vi.clearAllMocks();
  // Re-install default mock impls (mockReset:true wipes them between tests).
  const s3 = await import("../services/s3-upload.js");
  vi.mocked(s3.uploadStaticSite).mockResolvedValue({
    uploaded: 3,
    failed: 0,
    totalBytes: 15360,
    errors: [],
  });
  vi.mocked(s3.configureBucketPolicy).mockResolvedValue(undefined);

  const cf = await import("../services/cloudfront-setup.js");
  vi.mocked(cf.createCloudFrontDistribution).mockResolvedValue({
    distributionId: "E1234EXAMPLE",
    domainName: "d1234example.cloudfront.net",
    distributionArn:
      "arn:aws:cloudfront::123456789012:distribution/E1234EXAMPLE",
  });
  vi.mocked(cf.generateCloudFrontBucketPolicy).mockReturnValue(
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "AllowCloudFrontServicePrincipalReadOnly",
          Effect: "Allow",
          Principal: { Service: "cloudfront.amazonaws.com" },
          Action: "s3:GetObject",
          Resource: "arn:aws:s3:::mock-bucket/*",
        },
      ],
    }),
  );

  const display = await import("../utils/display.js");
  vi.mocked(display.promptFixSelection).mockResolvedValue(null);

  const memory = await import("../services/memory.js");
  vi.mocked(memory.defaultMemoryService.appendProvision).mockResolvedValue(
    undefined,
  );
  vi.mocked(memory.defaultMemoryService.appendFailure).mockResolvedValue(
    undefined,
  );
  vi.mocked(memory.defaultMemoryService.upsertPattern).mockResolvedValue(
    undefined,
  );
  vi.mocked(memory.defaultMemoryService.clearFailuresForType).mockResolvedValue(
    undefined,
  );

  // Provide realistic-shaped operator env vars so the centralized helper
  // (used by the result-formatter CloudFront S3Client) can construct an
  // S3Client. Tests that exercise fail-closed behavior delete these.
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});

afterEach(() => {
  process.env = { ...RESULT_FORMATTER_ORIGINAL_ENV };
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

describe("resultFormatterNode — apply mode with BP blocking (PENDING + preflightPassed=false)", () => {
  it("calls renderPlanBox in apply mode when preflightPassed is false", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.PENDING,
      executionMode: ExecutionMode.APPLY,
      preflightPassed: false,
      bpFindings: [
        {
          practiceId: "BP-S3-001",
          title: "Block public ACLs",
          severity: "CRITICAL",
          category: "security",
          message: "S3 bucket should block public ACLs",
          blocking: true,
        },
      ],
    });
    await resultFormatterNode(state);
    expect(renderPlanBox).toHaveBeenCalledWith(state);
  });

  it("does NOT call renderPlanBox in apply mode when preflightPassed is true", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.PENDING,
      executionMode: ExecutionMode.APPLY,
      preflightPassed: true,
    });
    await resultFormatterNode(state);
    // preflightPassed=true in apply mode should NOT render plan box
    // (graph should have routed to human_approval instead)
    expect(renderPlanBox).not.toHaveBeenCalled();
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

  it("includes ARNs and reverse-order destroy commands in cleanup guidance (EC-22)", async () => {
    const resourceQueue = makeResourceQueue();
    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
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
      resourceType: "AWS::ApiGatewayV2::Api",
      errorMessage: "API Gateway creation failed",
    });

    await resultFormatterNode(state);

    expect(renderError).toHaveBeenCalledOnce();
    const [errorMsg] = vi.mocked(renderError).mock.calls[0] as [
      string,
      ...unknown[],
    ];
    // Should list ARNs
    expect(errorMsg).toContain("arn:aws:iam::123:role/exec-role");
    expect(errorMsg).toContain("arn:aws:lambda::123:function:my-fn");
    // Should include destroy commands in reverse order (Lambda before IAM)
    const lambdaIdx = errorMsg.indexOf("assignee destroy arn:aws:lambda");
    const iamIdx = errorMsg.indexOf("assignee destroy arn:aws:iam");
    expect(lambdaIdx).toBeLessThan(iamIdx);
    // Should mention reverse dependency order
    expect(errorMsg).toContain("reverse dependency order");
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
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as any);
    const tool = {
      name: "AnalyzeSecurityPosture",
      invoke: vi.fn().mockRejectedValue(new Error("Connection refused")),
    } as unknown as StructuredTool;
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: "arn:aws:s3:::my-bucket-12345",
    });

    const result = await resultFormatterNode(state, [tool]);

    expect(stderrSpy).toHaveBeenCalledWith(
      "Security posture check skipped (MCP server unavailable)\n",
    );
    expect(result).toEqual({});
    stderrSpy.mockRestore();
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

// ── Story 20.13: Clear failure history after successful provision ──────────

describe("resultFormatterNode — Story 20.13 clear failure history on success", () => {
  it("clears failure history for resource type after single-resource SUCCESS", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: "arn:aws:s3:::my-bucket",
      resourceType: "AWS::S3::Bucket",
    });

    await resultFormatterNode(state);

    expect(defaultMemoryService.clearFailuresForType).toHaveBeenCalledWith(
      "AWS::S3::Bucket",
    );
  });

  it("clears failure history for each resource type after compound SUCCESS final", async () => {
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

    // Should clear for all 3 unique resource types
    expect(defaultMemoryService.clearFailuresForType).toHaveBeenCalledWith(
      "AWS::IAM::Role",
    );
    expect(defaultMemoryService.clearFailuresForType).toHaveBeenCalledWith(
      "AWS::Lambda::Function",
    );
    expect(defaultMemoryService.clearFailuresForType).toHaveBeenCalledWith(
      "AWS::ApiGatewayV2::Api",
    );
  });

  it("does not clear failure history on FAILED status", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      resourceType: "AWS::S3::Bucket",
      errorMessage: "Bucket creation failed",
    });

    await resultFormatterNode(state);

    expect(defaultMemoryService.clearFailuresForType).not.toHaveBeenCalled();
  });

  it("clearFailuresForType failure does not affect success result", async () => {
    vi.mocked(defaultMemoryService.clearFailuresForType).mockRejectedValueOnce(
      new Error("Disk full"),
    );

    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceArn: "arn:aws:s3:::my-bucket",
      resourceType: "AWS::S3::Bucket",
    });

    const result = await resultFormatterNode(state);

    expect(renderApplySuccess).toHaveBeenCalledWith(state);
    expect(result).toEqual({});
  });
});

// ── P1-2: Plan mode text — promptFixSelection applied → returns updated state ──

describe("resultFormatterNode — P1-2 plan mode promptFixSelection integration", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.mocked(process.stdout.write).mockRestore();
  });

  it("plan mode: promptFixSelection applied → returns updated desiredState/bpFindings/appliedFixes", async () => {
    const mockFixResult = {
      desiredState: {
        BucketName: "my-bucket",
        PublicAccessBlockConfiguration: { BlockPublicAcls: true },
      },
      bpFindings: [
        {
          practiceId: "BP-S3-010",
          title: "S3 lifecycle",
          severity: "MEDIUM",
          category: "cost",
          message: "Missing lifecycle",
          blocking: false,
          propertyPath: "LifecycleConfiguration",
        },
      ],
      appliedFixes: [
        {
          practiceId: "BP-S3-001",
          title: "Block S3 Public Access",
          fieldPath: "PublicAccessBlockConfiguration.BlockPublicAcls",
          oldValue: undefined,
          newValue: true,
        },
      ],
    };

    vi.mocked(promptFixSelection).mockResolvedValueOnce(
      mockFixResult as FixSelectionResult,
    );

    const state = makeState({
      executionStatus: ExecutionStatus.PENDING,
      executionMode: ExecutionMode.PLAN,
      desiredState: { BucketName: "my-bucket" },
      estimatedMonthlyCost: "$0.0230/GB-month",
      bpFindings: [
        {
          practiceId: "BP-S3-001",
          title: "Block S3 Public Access",
          severity: "CRITICAL",
          category: "security",
          message: "S3 bucket allows public access",
          blocking: true,
          autoFixable: true,
          propertyPath: "PublicAccessBlockConfiguration.BlockPublicAcls",
          desiredStatePatch: {
            PublicAccessBlockConfiguration: { BlockPublicAcls: true },
          },
        },
        {
          practiceId: "BP-S3-010",
          title: "S3 lifecycle",
          severity: "MEDIUM",
          category: "cost",
          message: "Missing lifecycle",
          blocking: false,
          propertyPath: "LifecycleConfiguration",
        },
      ] as any,
    });

    const result = await resultFormatterNode(state);

    // renderPlanBox called twice: initial render + re-render after fix
    expect(renderPlanBox).toHaveBeenCalledTimes(2);
    // First call with original state
    expect(renderPlanBox).toHaveBeenNthCalledWith(1, state);
    // Second call with updated state (patched desiredState, residual findings)
    // Cost estimate is preserved (not cleared to N/A) — spread from original state
    expect(renderPlanBox).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        desiredState: mockFixResult.desiredState,
        bpFindings: mockFixResult.bpFindings,
        appliedFixes: mockFixResult.appliedFixes,
        resourceType: state.resourceType,
        estimatedMonthlyCost: "$0.0230/GB-month",
      }),
    );

    // Return value contains the updated fields
    expect(result).toEqual({
      desiredState: mockFixResult.desiredState,
      bpFindings: mockFixResult.bpFindings,
      appliedFixes: mockFixResult.appliedFixes,
    });
  });

  it("plan mode: promptFixSelection returns null → no re-render, returns empty", async () => {
    vi.mocked(promptFixSelection).mockResolvedValueOnce(null);

    const state = makeState({
      executionStatus: ExecutionStatus.PENDING,
      executionMode: ExecutionMode.PLAN,
      desiredState: { BucketName: "my-bucket" },
    });

    const result = await resultFormatterNode(state);

    // renderPlanBox called only once (initial render)
    expect(renderPlanBox).toHaveBeenCalledTimes(1);
    expect(result).toEqual({});
  });
});

// ── P1-3: Plan mode JSON — promptFixSelection NOT called ──

describe("resultFormatterNode — P1-3 plan mode JSON skips promptFixSelection", () => {
  let stdoutCalls: string[];

  beforeEach(() => {
    stdoutCalls = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutCalls.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.mocked(process.stdout.write).mockRestore();
  });

  it("plan mode JSON: promptFixSelection NOT called, JSON written to stdout", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.PENDING,
      executionMode: ExecutionMode.PLAN,
      outputFormat: "json",
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "my-bucket" },
      bpFindings: [
        {
          practiceId: "BP-S3-001",
          title: "Block S3 Public Access",
          severity: "CRITICAL",
          category: "security",
          message: "S3 bucket allows public access",
          blocking: true,
        },
      ] as any,
    });

    const result = await resultFormatterNode(state);

    // promptFixSelection must NOT be called for JSON output
    expect(promptFixSelection).not.toHaveBeenCalled();
    // renderPlanBox must NOT be called for JSON output
    expect(renderPlanBox).not.toHaveBeenCalled();
    // JSON should have been written to stdout
    const written = stdoutCalls.join("");
    const parsed = JSON.parse(written.trim());
    expect(parsed.resourceType).toBe("AWS::S3::Bucket");
    expect(parsed.desiredState).toEqual({ BucketName: "my-bucket" });
    expect(parsed.bpFindings).toHaveLength(1);
    expect(result).toEqual({});
  });
});

// ── Story 37.4: Post-provision static site upload ───────────────────────────

describe("resultFormatterNode — Story 37.4 static site upload", () => {
  let stdoutSpy: any;

  let stderrSpy: any;

  beforeEach(() => {
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as any);
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as any);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("uploads files and shows website URL when sourceDir is set for S3 bucket (no CloudFront for single-resource)", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceType: "AWS::S3::Bucket",
      resourceArn: "arn:aws:s3:::my-static-site-bucket",
      sourceDir: "/tmp/build",
    });

    const result = await resultFormatterNode(state);

    // Should call uploadStaticSite with bucket name and sourceDir
    expect(uploadStaticSite).toHaveBeenCalledWith(
      "my-static-site-bucket",
      "/tmp/build",
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );

    // Single-resource S3 buckets do NOT get CloudFront
    expect(createCloudFrontDistribution).not.toHaveBeenCalled();

    // Should set public-read bucket policy instead
    expect(configureBucketPolicy).toHaveBeenCalledWith("my-static-site-bucket");

    // Should show S3 website URL only (no CloudFront)
    const allStdout = stdoutSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("");
    expect(allStdout).toContain("my-static-site-bucket.s3-website-");
    expect(allStdout).toContain(".amazonaws.com");
    expect(allStdout).not.toContain("d1234example.cloudfront.net");

    // Result should be empty — upload does not affect provision status
    expect(result).toEqual({});
  });

  it("does NOT upload when sourceDir is not set", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceType: "AWS::S3::Bucket",
      resourceArn: "my-bucket",
    });

    await resultFormatterNode(state);

    expect(uploadStaticSite).not.toHaveBeenCalled();
    expect(createCloudFrontDistribution).not.toHaveBeenCalled();
  });

  it("does NOT upload for non-S3 resource types", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceType: "AWS::Lambda::Function",
      resourceArn: "arn:aws:lambda::123:function:my-fn",
      sourceDir: "/tmp/build",
    });

    await resultFormatterNode(state);

    expect(uploadStaticSite).not.toHaveBeenCalled();
    expect(createCloudFrontDistribution).not.toHaveBeenCalled();
  });

  it("does NOT upload when resourceArn is undefined", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceType: "AWS::S3::Bucket",
      resourceArn: undefined,
      sourceDir: "/tmp/build",
    });

    await resultFormatterNode(state);

    expect(uploadStaticSite).not.toHaveBeenCalled();
  });

  it("upload failure does NOT mark provision as failed", async () => {
    vi.mocked(uploadStaticSite).mockRejectedValueOnce(
      new Error("Access denied"),
    );

    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceType: "AWS::S3::Bucket",
      resourceArn: "arn:aws:s3:::my-bucket",
      sourceDir: "/tmp/build",
    });

    const result = await resultFormatterNode(state);

    // renderApplySuccess should still have been called
    expect(renderApplySuccess).toHaveBeenCalledWith(state);

    // Should show warning about upload failure
    const allStderr = stderrSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("");
    expect(allStderr).toContain("File upload failed");
    expect(allStderr).toContain("aws s3 sync");

    // Result should be empty — provision is still successful
    expect(result).toEqual({});
  });

  it("shows warning when some files fail to upload", async () => {
    vi.mocked(uploadStaticSite).mockResolvedValueOnce({
      uploaded: 2,
      failed: 1,
      totalBytes: 10240,
      errors: [{ file: "broken.html", error: "Permission denied" }],
    });

    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceType: "AWS::S3::Bucket",
      resourceArn: "arn:aws:s3:::my-bucket",
      sourceDir: "/tmp/build",
    });

    await resultFormatterNode(state);

    const allStderr = stderrSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("");
    expect(allStderr).toContain("1 files failed to upload");
    expect(allStderr).toContain("broken.html");
    expect(allStderr).toContain("Permission denied");
  });

  it("single-resource S3 bucket uses public-read policy (no CloudFront attempted)", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceType: "AWS::S3::Bucket",
      resourceArn: "arn:aws:s3:::my-bucket",
      sourceDir: "/tmp/build",
    });

    await resultFormatterNode(state);

    // Upload should succeed
    expect(uploadStaticSite).toHaveBeenCalled();

    // Single-resource path should NOT attempt CloudFront
    expect(createCloudFrontDistribution).not.toHaveBeenCalled();

    // Should set public-read bucket policy directly
    expect(configureBucketPolicy).toHaveBeenCalledWith("my-bucket");

    // Should show S3 website URL
    const allStdout = stdoutSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("");
    expect(allStdout).toContain("my-bucket.s3-website-");
  });

  it("uses AWS_REGION env for website URL", async () => {
    const originalRegion = process.env["AWS_REGION"];
    process.env["AWS_REGION"] = "eu-west-1";

    try {
      const state = makeState({
        executionStatus: ExecutionStatus.SUCCESS,
        resourceType: "AWS::S3::Bucket",
        resourceArn: "arn:aws:s3:::my-bucket",
        sourceDir: "/tmp/build",
      });

      await resultFormatterNode(state);

      const allStdout = stdoutSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join("");
      expect(allStdout).toContain(
        "my-bucket.s3-website-eu-west-1.amazonaws.com",
      );
    } finally {
      if (originalRegion !== undefined) {
        process.env["AWS_REGION"] = originalRegion;
      } else {
        delete process.env["AWS_REGION"];
      }
    }
  });

  // ── Fail-closed: missing operator env vars ────────────────────────────────
  // The result-formatter dynamically imports `requireAssigneeCredentials`
  // when constructing the S3Client used to apply the CloudFront OAC bucket
  // policy. With env vars unset, that helper throws — and the upload flow
  // catches the error and continues without leaking to the default chain.
  it("fail-closed: upload still completes when ASSIGNEE_OPERATOR_* missing", async () => {
    delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
    delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
    // Belt-and-suspenders: shell AWS_* must NOT be honored
    process.env["AWS_ACCESS_KEY_ID"] = "shell-leak-key";
    process.env["AWS_SECRET_ACCESS_KEY"] = "shell-leak-secret";

    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceType: "AWS::S3::Bucket",
      resourceArn: "arn:aws:s3:::my-static-site",
      sourceDir: "/tmp/build",
    });

    // Single-resource S3 bucket path does NOT call CloudFront — and the
    // public-read configureBucketPolicy is mocked above. Even with missing
    // operator creds, the upload flow must NOT throw all the way out and
    // must NOT mark provision as failed.
    const result = await resultFormatterNode(state);
    expect(result).toEqual({});
    expect(uploadStaticSite).toHaveBeenCalled();
  });
});
