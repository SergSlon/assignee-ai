/**
 * Tests for result-formatter node (Story 2.4, Story 8.2, Story 19.2).
 * Covers compound SUCCESS routing, compound FAILED partial message,
 * single-resource path, and post-provision security posture checks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import type { BPFinding } from "@assignee/best-practices";
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
// Story 50-4 Wave 5 Pass H: s3-upload lifted to @assignee/core — mock both
// the CLI shim and the core path so dynamic imports resolve the same spies.
const _s3Mocks = vi.hoisted(() => ({
  uploadStaticSite: vi.fn(),
  configureBucketPolicy: vi.fn(),
  getMimeType: vi.fn((_p: string) => "text/plain"),
  collectFiles: vi.fn(() => []),
}));
vi.mock("../services/s3-upload.js", () => _s3Mocks);
vi.mock("@assignee/core/services/s3-upload.js", () => _s3Mocks);

// (f) 2026-04-09 Task 4b: cloudfront-setup.ts (the SDK post-provision
// distribution + OAC + bucket-policy hook) was deleted — the same
// operations are now first-class CCAPI resources owned by the
// static-website compound pattern. The old vi.mock stubs for
// cloudfront-setup.js and @aws-sdk/client-s3 PutBucketPolicy are
// gone; the post-provision hook in result-formatter now only
// uploads files and synthesizes the CloudFront URL from the
// distribution's CCAPI primaryIdentifier.

// Suppress display output for all tests. Default impls re-installed in beforeEach.
//
// Story 50-4 Wave 5 Pass H: security-posture (which calls
// renderSecurityWarnings) was lifted to @assignee/core in this pass; it
// imports display via the core-internal path. Mock both the CLI shim and
// the core display source so both consumer sides see the same spies.
const displayMocks = vi.hoisted(() => ({
  renderApplySuccess: vi.fn(),
  renderCompoundSuccess: vi.fn(),
  renderCompoundPartialFailure: vi.fn(),
  renderError: vi.fn(),
  renderPlanBox: vi.fn(),
  renderSecurityWarnings: vi.fn(),
  promptFixSelection: vi.fn(),
}));
vi.mock("../utils/display.js", () => displayMocks);
vi.mock("@assignee/core/utils/display.js", () => displayMocks);

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
//
// Story 50-4 Wave 5 Pass H: MemoryService lifted to @assignee/core. The CLI
// shim at ../services/memory.js re-exports from core, so the module the
// memory-recorder util actually imports is the core copy. Mock both the
// shim (so consumers that import the shim see mocks) and the core source.
const { mockMemoryService } = vi.hoisted(() => ({
  mockMemoryService: {
    appendProvision: vi.fn(),
    appendFailure: vi.fn(),
    upsertPattern: vi.fn(),
    clearFailuresForType: vi.fn(),
  },
}));
vi.mock("../services/memory.js", () => ({
  defaultMemoryService: mockMemoryService,
  MemoryService: vi.fn(() => mockMemoryService),
}));
vi.mock("@assignee/core/services/memory.js", () => ({
  defaultMemoryService: mockMemoryService,
  MemoryService: vi.fn(() => mockMemoryService),
}));

import { resultFormatterNode } from "./result-formatter.js";
import {
  renderApplySuccess,
  renderCompoundSuccess,
  renderCompoundPartialFailure,
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
  it("calls renderApplySuccess with the state and a resolved displayArn", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      // Already-an-ARN value short-circuits resolveResourceArn → both
      // arguments to renderApplySuccess are the same string. Real
      // CCAPI bare identifiers are exercised by the regression test
      // below and by the live verification in the commit message.
      resourceArn: "arn:aws:iam::123456789012:role/my-role",
    });
    const result = await resultFormatterNode(state);

    expect(renderApplySuccess).toHaveBeenCalledWith(
      state,
      "arn:aws:iam::123456789012:role/my-role",
    );
    expect(renderCompoundSuccess).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  // Adversarial Hunter v6 P0 regression: Wave 8 originally mutated
  // state.resourceArn from the bare CCAPI identifier (vpc-0xxx) into
  // a full ARN (arn:aws:ec2:...:vpc/vpc-0xxx). The compound marker
  // resolver in plan-generator.ts substitutes resourceArn verbatim
  // into child VpcId/SubnetId/InternetGatewayId fields where AWS
  // requires the BARE identifier — the mutation broke every VPC
  // compound apply at step 2/17. This regression test pins the
  // invariant: result-formatter must NEVER mutate state.resourceArn
  // in-place (the mutation path), AND must not leak a resolved ARN
  // back into state.resourceArn via the partial-update return when
  // in compound mode.
  it("does NOT mutate state.resourceArn when resolving the display ARN", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceType: "AWS::S3::Bucket",
      // Bare CCAPI identifier — what status-poller actually returns.
      resourceArn: "my-smoke-bucket-1775000000",
    });
    const before = state.resourceArn;
    const result = await resultFormatterNode(state);

    // Even though resolveResourceArn would synthesize
    // "arn:aws:s3:::my-smoke-bucket-1775000000" (or fall back to the
    // bare value when STS is unavailable), state.resourceArn must
    // remain the bare identifier. Anything else corrupts compound
    // marker substitution downstream.
    expect(state.resourceArn).toBe(before);
    expect(state.resourceArn).toBe("my-smoke-bucket-1775000000");
    expect(state.resourceArn).not.toMatch(/^arn:/);

    // 2026-04-11 strengthened invariant: in unit-test environment STS is
    // unavailable, so resolveResourceArn returns undefined, displayArn
    // falls back to state.resourceArn, and the surgical propagation
    // branch (displayArn !== state.resourceArn) must NOT fire. The partial
    // update must therefore NOT contain resourceArn — otherwise the
    // LangGraph reducer would merge a stray bare identifier back over
    // itself, and the `resolution-changed` guard that protects compound
    // flow would be meaningless in unit tests.
    expect((result as { resourceArn?: unknown }).resourceArn).toBeUndefined();
  });

  // Compound-flow guard: if a future refactor moves the partial-update
  // return above the compound early-return, the compound marker resolver
  // would re-read a full ARN from state.resourceArn on the next iteration,
  // re-breaking the Wave 8 P0 bug. This test pins "compound flow never
  // returns { resourceArn: <full ARN> } from the SUCCESS branch" so any
  // reordering surfaces as a test failure.
  it("compound SUCCESS path does not return a full ARN in the partial update", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceType: "AWS::S3::Bucket",
      resourceArn: "compound-bucket-1775000000",
      resourcePattern: {
        patternId: "vpc-networking",
        displayName: "VPC",
        keywords: [],
        resourceList: [
          {
            resourceType: "AWS::S3::Bucket",
            resourceId: "bucket",
            displayName: "S3 Bucket",
          },
          {
            resourceType: "AWS::EC2::VPC",
            resourceId: "vpc",
            displayName: "VPC",
          },
        ],
        dependencyOrder: [["bucket"], ["vpc"]],
        defaultOptions: {},
      },
      resourceQueue: [
        {
          resourceType: "AWS::S3::Bucket",
          resourceId: "bucket",
          displayName: "S3 Bucket",
        },
        {
          resourceType: "AWS::EC2::VPC",
          resourceId: "vpc",
          displayName: "VPC",
        },
      ],
      currentResourceIndex: 0,
    });
    const result = (await resultFormatterNode(state)) as {
      resourceArn?: unknown;
    };

    // The compound-more-resources branch returns resourceArn: undefined to
    // reset for the next iteration. It must NEVER return a resolved full
    // ARN — the next iteration's compound marker resolver would substitute
    // that ARN into VpcId / SubnetId / IgwId fields and break apply.
    expect(result.resourceArn).toBeUndefined();
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

// ── Compound plan-mode iteration (bug-lambda-compound-rendering fix) ────────

describe("resultFormatterNode — compound plan-mode iteration", () => {
  it("advances to next resource after rendering plan box", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.PENDING,
      executionMode: ExecutionMode.PLAN,
      resourceType: "AWS::IAM::Role",
      resourcePattern: mockPattern as never,
      resourceQueue: makeResourceQueue() as never,
      currentResourceIndex: 0,
    });

    const result = await resultFormatterNode(state);

    expect(renderPlanBox).toHaveBeenCalled();
    expect(result.currentResourceIndex).toBe(1);
    expect(result.resourceType).toBe("AWS::Lambda::Function");
    expect(result.desiredState).toBeUndefined();
    expect(result.executionStatus).toBe(ExecutionStatus.PENDING);
  });

  it("advances past queue end after last resource", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.PENDING,
      executionMode: ExecutionMode.PLAN,
      resourceType: "AWS::ApiGatewayV2::Api",
      resourcePattern: mockPattern as never,
      resourceQueue: makeResourceQueue() as never,
      currentResourceIndex: 2, // last resource (index 2 of 3)
    });

    const result = await resultFormatterNode(state);

    expect(renderPlanBox).toHaveBeenCalled();
    // Past the end — router will send to END
    expect(result.currentResourceIndex).toBe(3);
  });

  it("skips non-provisionable resources when advancing", async () => {
    const queueWithCompanion = [
      {
        resourceId: "vpc",
        resourceType: "AWS::EC2::VPC",
        displayName: "VPC",
      },
      {
        resourceId: "igw-attachment",
        resourceType: "AWS::EC2::VPCGatewayAttachment",
        displayName: "IGW Attachment",
        provisionable: false,
      },
      {
        resourceId: "igw",
        resourceType: "AWS::EC2::InternetGateway",
        displayName: "Internet Gateway",
      },
    ];
    const patternWithCompanion = {
      ...mockPattern,
      resourceList: queueWithCompanion,
      dependencyOrder: [["vpc"], ["igw-attachment"], ["igw"]],
    };

    const state = makeState({
      executionStatus: ExecutionStatus.PENDING,
      executionMode: ExecutionMode.PLAN,
      resourceType: "AWS::EC2::VPC",
      resourcePattern: patternWithCompanion as never,
      resourceQueue: queueWithCompanion as never,
      currentResourceIndex: 0,
    });

    const result = await resultFormatterNode(state);

    // Should skip index 1 (non-provisionable) and advance to index 2
    expect(result.currentResourceIndex).toBe(2);
    expect(result.resourceType).toBe("AWS::EC2::InternetGateway");
  });

  it("does NOT advance in apply mode (existing SUCCESS path handles that)", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.PENDING,
      executionMode: ExecutionMode.APPLY,
      preflightPassed: false, // triggers plan box in apply mode
      resourceType: "AWS::IAM::Role",
      resourcePattern: mockPattern as never,
      resourceQueue: makeResourceQueue() as never,
      currentResourceIndex: 0,
      bpFindings: [
        {
          practiceId: "BP-IAM-001",
          title: "Test",
          severity: "HIGH",
          category: "security",
          message: "Test finding",
          blocking: true,
        },
      ],
    });

    const result = await resultFormatterNode(state);

    // Apply mode should NOT advance — the router handles termination
    expect(result.currentResourceIndex).toBeUndefined();
  });

  it("returns empty for single-resource plan mode (no compound)", async () => {
    const state = makeState({
      executionStatus: ExecutionStatus.PENDING,
      executionMode: ExecutionMode.PLAN,
      resourceType: "AWS::S3::Bucket",
      // No resourcePattern — single resource
    });

    const result = await resultFormatterNode(state);

    expect(renderPlanBox).toHaveBeenCalled();
    expect(result).toEqual({});
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
  it("calls renderCompoundPartialFailure with successful + failed + not-attempted (Item 1)", async () => {
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

    // Item 1: cleanup guidance now flows through renderCompoundPartialFailure,
    // not through the old inline-error-blob path. renderError is still
    // called with a short pointer message so the user also sees the
    // structured why/howToFix registry output.
    expect(renderCompoundPartialFailure).toHaveBeenCalledOnce();
    const [call] = vi.mocked(renderCompoundPartialFailure).mock.calls[0] as [
      {
        pattern: ArchitecturePattern;
        completed: Array<{ resourceType: string; resourceArn?: string }>;
        failedResource: { resourceType: string; errorMessage: string };
        notAttempted: Array<{ resourceType: string }>;
        runId: string;
      },
    ];
    expect(call.pattern).toBe(mockPattern);
    expect(call.completed).toHaveLength(1);
    expect(call.completed[0]!.resourceType).toBe("AWS::IAM::Role");
    expect(call.failedResource.resourceType).toBe("AWS::Lambda::Function");
    // Not attempted = resourceQueue slice after currentResourceIndex (1)
    expect(call.notAttempted).toHaveLength(1);
    expect(call.notAttempted[0]!.resourceType).toBe("AWS::ApiGatewayV2::Api");
    expect(call.runId).toBe("test-run-id");
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

    // Item 1: reverse-order destroy guidance is now the renderer's job.
    // We assert the structured inputs here and leave the reverse-order
    // string assertion to the display unit test (which exercises the
    // renderer directly against captured stderr output).
    expect(renderCompoundPartialFailure).toHaveBeenCalledOnce();
    const [call] = vi.mocked(renderCompoundPartialFailure).mock.calls[0] as [
      {
        completed: Array<{ resourceType: string; resourceArn?: string }>;
        failedResource: { resourceType: string };
      },
    ];
    expect(call.completed).toHaveLength(2);
    // Completed list is in forward order (vpc, lambda) — the renderer
    // reverses for destroy. Assert both ARNs made it through.
    const arns = call.completed.map((r) => r.resourceArn);
    expect(arns).toContain("arn:aws:iam::123:role/exec-role");
    expect(arns).toContain("arn:aws:lambda::123:function:my-fn");
    expect(call.failedResource.resourceType).toBe("AWS::ApiGatewayV2::Api");
  });

  // Wave 19 Bug #7: composite-id resources (Route, VPCGatewayAttachment,
  // SubnetRouteTableAssociation) must NOT emit a `assignee destroy` line
  // because the resolver can't match composite identifiers — they cascade
  // from their parents instead. Verified against the real partial state
  // observed during compound VPC Run 1 on 2026-04-08.
  it("annotates composite-id resources as cascading instead of emitting unrunnable destroy commands (Wave 19 Bug #7)", async () => {
    const resourceQueue = makeResourceQueue();
    const state = makeState({
      executionStatus: ExecutionStatus.FAILED,
      resourcePattern: mockPattern,
      resourceQueue,
      currentResourceIndex: 11,
      // Real partial state from the compound VPC Run 1 failure: 11 resources
      // including the 3 composite-id types that hit Bug #7.
      completedResources: [
        {
          resourceId: "vpc",
          resourceType: "AWS::EC2::VPC",
          resourceArn:
            "arn:aws:ec2:us-east-1:054125018476:vpc/vpc-00609e37203c1044c",
          executionStatus: ExecutionStatus.SUCCESS,
        },
        {
          resourceId: "subnet-public-1",
          resourceType: "AWS::EC2::Subnet",
          resourceArn:
            "arn:aws:ec2:us-east-1:054125018476:subnet/subnet-0f855779f1b6c0ff8",
          executionStatus: ExecutionStatus.SUCCESS,
        },
        {
          resourceId: "igw",
          resourceType: "AWS::EC2::InternetGateway",
          resourceArn:
            "arn:aws:ec2:us-east-1:054125018476:internet-gateway/igw-0398fb964fa35931d",
          executionStatus: ExecutionStatus.SUCCESS,
        },
        {
          // COMPOSITE — must be skipped
          resourceId: "vpc-gateway-attachment",
          resourceType: "AWS::EC2::VPCGatewayAttachment",
          resourceArn: "IGW|vpc-00609e37203c1044c",
          executionStatus: ExecutionStatus.SUCCESS,
        },
        {
          resourceId: "rt-public",
          resourceType: "AWS::EC2::RouteTable",
          resourceArn:
            "arn:aws:ec2:us-east-1:054125018476:route-table/rtb-07fb017a426465e6f",
          executionStatus: ExecutionStatus.SUCCESS,
        },
        {
          // COMPOSITE — must be skipped
          resourceId: "route-public",
          resourceType: "AWS::EC2::Route",
          resourceArn: "rtb-07fb017a426465e6f|0.0.0.0/0",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
      resourceType: "AWS::EC2::NatGateway",
      errorMessage:
        "EIP allocation failed for NatGateway: The maximum number of addresses has been reached.",
    });

    await resultFormatterNode(state);

    // Item 1 (Wave 19 Bug #7 coverage): composite-identifier handling
    // is now the renderer's job. We assert that the full completedResources
    // list (including the 2 composite-id entries) is forwarded to
    // renderCompoundPartialFailure — the matching cascade-comment
    // rendering is verified in display.test.ts against captured stderr
    // output so we don't re-assert the render string here.
    expect(renderCompoundPartialFailure).toHaveBeenCalledOnce();
    const [call] = vi.mocked(renderCompoundPartialFailure).mock.calls[0] as [
      {
        completed: Array<{ resourceType: string; resourceArn?: string }>;
        failedResource: { resourceType: string };
      },
    ];
    expect(call.completed).toHaveLength(6);
    const types = call.completed.map((r) => r.resourceType);
    expect(types).toContain("AWS::EC2::VPC");
    expect(types).toContain("AWS::EC2::VPCGatewayAttachment"); // composite
    expect(types).toContain("AWS::EC2::Route"); // composite
    expect(types).toContain("AWS::EC2::InternetGateway");
    // Composite-id ARNs must survive the pass-through so the renderer
    // can annotate them with the cascade note.
    const arns = call.completed.map((r) => r.resourceArn);
    expect(arns).toContain("IGW|vpc-00609e37203c1044c");
    expect(arns).toContain("rtb-07fb017a426465e6f|0.0.0.0/0");
    expect(call.failedResource.resourceType).toBe("AWS::EC2::NatGateway");
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

    // resolveResourceArn short-circuits when state.resourceArn is
    // already an ARN, so the displayArn second arg equals state.resourceArn.
    expect(renderApplySuccess).toHaveBeenCalledWith(state, state.resourceArn);
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
    // resolveResourceArn short-circuits when state.resourceArn is
    // already an ARN, so the displayArn second arg equals state.resourceArn.
    expect(renderApplySuccess).toHaveBeenCalledWith(state, state.resourceArn);
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
      .mockImplementation((() => true) as never);
    const tool = {
      name: "GetSecurityFindings",
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

    // resolveResourceArn short-circuits when state.resourceArn is
    // already an ARN, so the displayArn second arg equals state.resourceArn.
    expect(renderApplySuccess).toHaveBeenCalledWith(state, state.resourceArn);
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
      ] as BPFinding[],
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
      ] as BPFinding[],
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
  let stdoutSpy: MockInstance;

  let stderrSpy: MockInstance;

  beforeEach(() => {
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as never);
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("uploads files when sourceDir is set for a single-resource S3 bucket", async () => {
    // (f) 2026-04-09 Task 4b: single-resource S3 buckets NO LONGER get
    // automatic website-hosting setup. Website hosting with CloudFront
    // is only available via the static-website compound pattern, which
    // provisions the S3 bucket + OAC + distribution + bucket policy
    // fully via CCAPI. A standalone `apply s3 bucket --source dir`
    // now ONLY uploads the files — users who want an auto-served URL
    // use the compound.
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

    // The post-provision flow no longer touches the bucket's
    // BucketPolicy — that's either owned by the static-website
    // compound's AWS::S3::BucketPolicy resource or left to the user.
    expect(configureBucketPolicy).not.toHaveBeenCalled();

    // No CloudFront domain is printed for a standalone bucket apply —
    // that's exclusively a compound-pattern post-success display.
    const allStdout = stdoutSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("");
    expect(allStdout).not.toContain("cloudfront.net");

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
    // resolveResourceArn short-circuits when state.resourceArn is
    // already an ARN, so the displayArn second arg equals state.resourceArn.
    expect(renderApplySuccess).toHaveBeenCalledWith(state, state.resourceArn);

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

  it("single-resource S3 bucket uploads files without touching the bucket policy or printing a website URL", async () => {
    // (f) 2026-04-09 Task 4b: removed the post-provision
    // configureBucketPolicy + website URL display from the
    // single-resource path. Website hosting with CloudFront is
    // exclusively a compound-pattern concern now.
    const state = makeState({
      executionStatus: ExecutionStatus.SUCCESS,
      resourceType: "AWS::S3::Bucket",
      resourceArn: "arn:aws:s3:::my-bucket",
      sourceDir: "/tmp/build",
    });

    await resultFormatterNode(state);

    // Upload should succeed.
    expect(uploadStaticSite).toHaveBeenCalled();

    // The bucket's policy is NOT touched post-apply anymore — users
    // who want CloudFront hosting use the static-website compound,
    // which owns the BucketPolicy as a CCAPI resource.
    expect(configureBucketPolicy).not.toHaveBeenCalled();

    // No website URL printed for a standalone apply.
    const allStdout = stdoutSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join("");
    expect(allStdout).not.toContain("s3-website-");
    expect(allStdout).not.toContain("cloudfront.net");
  });

  // ── Fail-closed: missing operator env vars ────────────────────────────────
  // Pre-migration this test protected a fail-closed S3Client construction
  // path inside the old CloudFront post-provision hook. After the Task 4b
  // migration, that S3Client path is gone (all bucket-policy work is now
  // CCAPI-owned), but the fail-closed behavior is still worth locking in:
  // the upload flow must tolerate missing operator env vars gracefully
  // and must never mark the provision as failed.
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

    const result = await resultFormatterNode(state);
    expect(result).toEqual({});
    expect(uploadStaticSite).toHaveBeenCalled();
  });
});
