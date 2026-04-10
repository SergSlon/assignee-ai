/**
 * Unit tests for graph-routing.ts
 * Story 9.9 — T6: graph-routing.ts tests — all branch conditions
 */

import { describe, it, expect } from "vitest";
import { END } from "@langchain/langgraph";
import { ExecutionMode, ExecutionStatus } from "@assignee/core";
import { GraphNode } from "../constants/graph.js";
import type { AgentState } from "./graph-state.js";
import {
  routeCheckpointEntry,
  routePreflightGuard,
  routeResourceProvisioner,
  routeStatusPoller,
  routeResultFormatter,
} from "./graph-routing.js";

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "",
    runId: "test-run",
    executionMode: ExecutionMode.APPLY,
    resourceType: "AWS::S3::Bucket",
    resourceSchema: undefined,
    desiredState: undefined,
    estimatedMonthlyCost: undefined,
    preflightPassed: false,
    preflightErrors: [],
    preflightMode: "LOCAL" as never,
    requestToken: undefined,
    resourceArn: undefined,
    executionStatus: ExecutionStatus.PENDING,
    errorMessage: undefined,
    startedAt: undefined,
    messages: [],
    elicitedOptions: undefined,
    resourcePattern: undefined,
    resourceQueue: undefined,
    currentResourceIndex: undefined,
    completedResources: undefined,
    perResourceCosts: undefined,
    error: undefined,
    orgConfig: undefined,
    userConfig: undefined,
    checkpointResumed: false,
    freeTierNote: undefined,
    noWizard: false,
    bpFindings: undefined,
    autoApprove: false,
    securityFindings: undefined,
    memoryHints: undefined,
    ...overrides,
  } as AgentState;
}

// ── routeCheckpointEntry ────────────────────────────────────────────────────

describe("routeCheckpointEntry", () => {
  it("T6.1: checkpoint exists + desiredState → routes to HUMAN_APPROVAL", () => {
    const result = routeCheckpointEntry(
      makeState({
        checkpointResumed: true,
        desiredState: { BucketName: "test" },
      }),
    );
    expect(result).toBe(GraphNode.HUMAN_APPROVAL);
  });

  it("T6.2: no checkpoint → routes to INTENT_PARSER", () => {
    const result = routeCheckpointEntry(
      makeState({ checkpointResumed: false }),
    );
    expect(result).toBe(GraphNode.INTENT_PARSER);
  });

  it("checkpoint resumed but no desiredState → routes to INTENT_PARSER", () => {
    const result = routeCheckpointEntry(
      makeState({ checkpointResumed: true, desiredState: undefined }),
    );
    expect(result).toBe(GraphNode.INTENT_PARSER);
  });
});

// ── routePreflightGuard ─────────────────────────────────────────────────────

describe("routePreflightGuard", () => {
  it("T6.3: plan mode → routes to RESULT_FORMATTER", () => {
    const result = routePreflightGuard(
      makeState({
        executionMode: ExecutionMode.PLAN,
        preflightPassed: true,
      }),
    );
    expect(result).toBe(GraphNode.RESULT_FORMATTER);
  });

  it("T6.4: apply mode, preflight passed, no compound → routes to HUMAN_APPROVAL", () => {
    const result = routePreflightGuard(
      makeState({
        executionMode: ExecutionMode.APPLY,
        preflightPassed: true,
      }),
    );
    expect(result).toBe(GraphNode.HUMAN_APPROVAL);
  });

  it("T6.5: apply mode, preflight failed → routes to RESULT_FORMATTER", () => {
    const result = routePreflightGuard(
      makeState({
        executionMode: ExecutionMode.APPLY,
        preflightPassed: false,
      }),
    );
    expect(result).toBe(GraphNode.RESULT_FORMATTER);
  });

  it("T6.6: compound iteration (index > 0) → routes to RESOURCE_PROVISIONER", () => {
    const result = routePreflightGuard(
      makeState({
        executionMode: ExecutionMode.APPLY,
        preflightPassed: true,
        resourcePattern: { patternId: "test" } as never,
        resourceQueue: [
          {
            resourceId: "r0",
            resourceType: "AWS::S3::Bucket",
            displayName: "Bucket 0",
          },
          {
            resourceId: "r1",
            resourceType: "AWS::S3::Bucket",
            displayName: "Bucket 1",
          },
        ] as never,
        currentResourceIndex: 1,
      }),
    );
    expect(result).toBe(GraphNode.RESOURCE_PROVISIONER);
  });

  it("FAILED status with preflightPassed → routes to RESULT_FORMATTER (safety guard)", () => {
    const result = routePreflightGuard(
      makeState({
        executionMode: ExecutionMode.APPLY,
        preflightPassed: true,
        executionStatus: ExecutionStatus.FAILED,
      }),
    );
    expect(result).toBe(GraphNode.RESULT_FORMATTER);
  });

  it("CANCELLED status with preflightPassed → routes to RESULT_FORMATTER (safety guard)", () => {
    const result = routePreflightGuard(
      makeState({
        executionMode: ExecutionMode.APPLY,
        preflightPassed: true,
        executionStatus: ExecutionStatus.CANCELLED,
      }),
    );
    expect(result).toBe(GraphNode.RESULT_FORMATTER);
  });

  it("compound, first resource (index 0) → routes to HUMAN_APPROVAL", () => {
    const result = routePreflightGuard(
      makeState({
        executionMode: ExecutionMode.APPLY,
        preflightPassed: true,
        resourcePattern: { patternId: "test" } as never,
        currentResourceIndex: 0,
      }),
    );
    expect(result).toBe(GraphNode.HUMAN_APPROVAL);
  });
});

// ── routeResourceProvisioner ────────────────────────────────────────────────

describe("routeResourceProvisioner", () => {
  it("T6.7: IN_PROGRESS → routes to STATUS_POLLER", () => {
    const result = routeResourceProvisioner(
      makeState({ executionStatus: ExecutionStatus.IN_PROGRESS }),
    );
    expect(result).toBe(GraphNode.STATUS_POLLER);
  });

  it("T6.8: not IN_PROGRESS (SUCCESS) → routes to RESULT_FORMATTER", () => {
    const result = routeResourceProvisioner(
      makeState({ executionStatus: ExecutionStatus.SUCCESS }),
    );
    expect(result).toBe(GraphNode.RESULT_FORMATTER);
  });

  it("FAILED → routes to RESULT_FORMATTER", () => {
    const result = routeResourceProvisioner(
      makeState({ executionStatus: ExecutionStatus.FAILED }),
    );
    expect(result).toBe(GraphNode.RESULT_FORMATTER);
  });
});

// ── routeStatusPoller ───────────────────────────────────────────────────────

describe("routeStatusPoller", () => {
  it("T6.9: IN_PROGRESS → loops back to STATUS_POLLER", () => {
    const result = routeStatusPoller(
      makeState({ executionStatus: ExecutionStatus.IN_PROGRESS }),
    );
    expect(result).toBe(GraphNode.STATUS_POLLER);
  });

  it("T6.10: SUCCESS → routes to RESULT_FORMATTER", () => {
    const result = routeStatusPoller(
      makeState({ executionStatus: ExecutionStatus.SUCCESS }),
    );
    expect(result).toBe(GraphNode.RESULT_FORMATTER);
  });

  it("FAILED → routes to RESULT_FORMATTER", () => {
    const result = routeStatusPoller(
      makeState({ executionStatus: ExecutionStatus.FAILED }),
    );
    expect(result).toBe(GraphNode.RESULT_FORMATTER);
  });
});

// ── routeResultFormatter ────────────────────────────────────────────────────

describe("routeResultFormatter", () => {
  it("T6.11: single resource → routes to END", () => {
    const result = routeResultFormatter(
      makeState({ executionStatus: ExecutionStatus.SUCCESS }),
    );
    expect(result).toBe(END);
  });

  it("T6.12: compound with remaining resources → loops to PLAN_GENERATOR", () => {
    const result = routeResultFormatter(
      makeState({
        resourcePattern: { patternId: "test" } as never,
        resourceQueue: [
          { resourceId: "r1" } as never,
          { resourceId: "r2" } as never,
        ],
        currentResourceIndex: 1,
        executionStatus: ExecutionStatus.PENDING,
        executionMode: ExecutionMode.APPLY,
        // Pattern-loop only runs when preflight passed on the previous iteration
        preflightPassed: true,
      }),
    );
    expect(result).toBe(GraphNode.PLAN_GENERATOR);
  });

  it("compound but all resources done (index === queue length) → END", () => {
    const result = routeResultFormatter(
      makeState({
        resourcePattern: { patternId: "test" } as never,
        resourceQueue: [{ resourceId: "r1" } as never],
        currentResourceIndex: 1,
        executionStatus: ExecutionStatus.PENDING,
        executionMode: ExecutionMode.APPLY,
      }),
    );
    expect(result).toBe(END);
  });

  it("compound plan mode with remaining resources → loops to PLAN_GENERATOR", () => {
    const result = routeResultFormatter(
      makeState({
        resourcePattern: { patternId: "test" } as never,
        resourceQueue: [
          { resourceId: "r1" } as never,
          { resourceId: "r2" } as never,
        ],
        currentResourceIndex: 1,
        executionStatus: ExecutionStatus.PENDING,
        executionMode: ExecutionMode.PLAN,
        preflightPassed: true,
      }),
    );
    expect(result).toBe(GraphNode.PLAN_GENERATOR);
  });

  it("compound plan mode past queue end → END", () => {
    const result = routeResultFormatter(
      makeState({
        resourcePattern: { patternId: "test" } as never,
        resourceQueue: [
          { resourceId: "r1" } as never,
          { resourceId: "r2" } as never,
        ],
        currentResourceIndex: 2, // past end
        executionStatus: ExecutionStatus.PENDING,
        executionMode: ExecutionMode.PLAN,
      }),
    );
    expect(result).toBe(END);
  });

  it("compound, status SUCCESS → END (not PENDING, no loop)", () => {
    const result = routeResultFormatter(
      makeState({
        resourcePattern: { patternId: "test" } as never,
        resourceQueue: [
          { resourceId: "r1" } as never,
          { resourceId: "r2" } as never,
        ],
        currentResourceIndex: 0,
        executionStatus: ExecutionStatus.SUCCESS,
        executionMode: ExecutionMode.APPLY,
      }),
    );
    expect(result).toBe(END);
  });

  it("no resourcePattern → END", () => {
    const result = routeResultFormatter(
      makeState({
        resourcePattern: undefined,
        executionStatus: ExecutionStatus.PENDING,
      }),
    );
    expect(result).toBe(END);
  });

  it("no resourceQueue → END", () => {
    const result = routeResultFormatter(
      makeState({
        resourcePattern: { patternId: "test" } as never,
        resourceQueue: undefined,
        currentResourceIndex: 0,
        executionStatus: ExecutionStatus.PENDING,
      }),
    );
    expect(result).toBe(END);
  });

  it("currentResourceIndex undefined → END", () => {
    const result = routeResultFormatter(
      makeState({
        resourcePattern: { patternId: "test" } as never,
        resourceQueue: [{ resourceId: "r1" } as never],
        currentResourceIndex: undefined,
        executionStatus: ExecutionStatus.PENDING,
      }),
    );
    expect(result).toBe(END);
  });

  // Regression: VPC compound apply hit the LangGraph recursionLimit because
  // a blocking BP finding on a companion resource (e.g. IGW "must be attached
  // to a VPC") left preflightPassed=false but executionStatus=PENDING, so the
  // compound loop kept re-planning the same resource forever. The router now
  // treats a failed preflight as terminal for the compound loop.
  it("compound PENDING with preflightPassed=false → END (do not infinite loop)", () => {
    const result = routeResultFormatter(
      makeState({
        resourcePattern: { patternId: "vpc-networking" } as never,
        resourceQueue: [
          { resourceId: "vpc" } as never,
          { resourceId: "igw" } as never,
        ],
        currentResourceIndex: 1,
        executionStatus: ExecutionStatus.PENDING,
        executionMode: ExecutionMode.APPLY,
        preflightPassed: false,
      }),
    );
    expect(result).toBe(END);
  });

  it("compound PENDING with preflightPassed=true still loops to PLAN_GENERATOR", () => {
    const result = routeResultFormatter(
      makeState({
        resourcePattern: { patternId: "vpc-networking" } as never,
        resourceQueue: [
          { resourceId: "vpc" } as never,
          { resourceId: "igw" } as never,
        ],
        currentResourceIndex: 1,
        executionStatus: ExecutionStatus.PENDING,
        executionMode: ExecutionMode.APPLY,
        preflightPassed: true,
      }),
    );
    expect(result).toBe(GraphNode.PLAN_GENERATOR);
  });
});
