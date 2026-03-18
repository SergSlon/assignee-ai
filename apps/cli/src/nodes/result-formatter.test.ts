/**
 * Tests for result-formatter node (Story 2.4, Story 8.2).
 * Covers compound SUCCESS routing, compound FAILED partial message, and
 * single-resource path (no change to existing behaviour).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExecutionStatus, ExecutionMode } from "@assignee/core";
import type { AgentState } from "../services/graph.js";
import type { ArchitecturePattern } from "@assignee/core";

// Suppress display output for all tests
vi.mock("../utils/display.js", () => ({
  renderApplySuccess: vi.fn(),
  renderCompoundSuccess: vi.fn(),
  renderError: vi.fn(),
  renderPlanBox: vi.fn(),
}));

// Suppress logger output
vi.mock("../utils/logger.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    RESULT_FORMATTED: "result_formatted",
    APPLY_SUCCEEDED: "apply_succeeded",
    APPLY_FAILED: "apply_failed",
  },
}));

import { resultFormatterNode } from "./result-formatter.js";
import {
  renderApplySuccess,
  renderCompoundSuccess,
  renderError,
  renderPlanBox,
} from "../utils/display.js";

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
