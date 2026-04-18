/**
 * Unit tests for plan-resource handler step helpers.
 *
 * Story 54-it1-07 extracted the inner arrow of `plan_resource` into
 * focused phase helpers. These tests pin the behaviour of each helper
 * in isolation so future refactors can't drift the contract that the
 * orchestrator (plan-resource.ts) and integration tests
 * (__tests__/plan-resource.test.ts) rely on.
 */

import { describe, expect, it } from "vitest";
import {
  BPEnforcementLevel,
  ExecutionMode,
  ExecutionStatus,
  StateField,
} from "@assignee/core";
import type { GraphContext } from "../../services/graph-init.js";
import {
  buildInitialGraphState,
  buildUnexpectedErrorResponse,
  checkExecutionStatus,
  enrichDescriptionWithEnv,
  guardContext,
  PLAN_GENERATION_FAILED,
} from "./handler-steps.js";

/** Parse the JSON payload out of an MCP tool response. */
function parseResponse(response: {
  content: Array<{ type: string; text: string }>;
}): Record<string, unknown> {
  const firstContent = response.content[0]!;
  return JSON.parse(firstContent.text) as Record<string, unknown>;
}

describe("guardContext", () => {
  it("returns NOT_READY done-step when ctx is undefined", () => {
    const result = guardContext(undefined);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") throw new Error("unreachable");
    const data = parseResponse(result.response);
    expect(result.response.isError).toBe(true);
    expect(data["error"]).toBe(true);
    expect(data["status"]).toBe("NOT_READY");
    expect(data["message"]).toBe(
      "Graph context not initialized. The MCP server may still be starting up.",
    );
  });

  it("returns continue-step carrying the ctx when ctx is defined", () => {
    const ctx: GraphContext = {
      graph: {
        invoke: async () => ({}),
        getState: async () => ({ values: {}, next: [] }),
      },
      cleanup: async () => {},
    };

    const result = guardContext(ctx);

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") throw new Error("unreachable");
    expect(result.context).toBe(ctx);
  });
});

describe("enrichDescriptionWithEnv", () => {
  it("prepends [env:<env>] when env is provided", () => {
    expect(enrichDescriptionWithEnv("Create an S3 bucket", "production")).toBe(
      "[env:production] Create an S3 bucket",
    );
  });

  it("returns the description unchanged when env is undefined", () => {
    expect(enrichDescriptionWithEnv("Create a Lambda", undefined)).toBe(
      "Create a Lambda",
    );
  });

  it("handles an explicit empty-string env as falsy (no prefix)", () => {
    expect(enrichDescriptionWithEnv("Create a bucket", "")).toBe(
      "Create a bucket",
    );
  });
});

describe("buildInitialGraphState", () => {
  it("carries awsRegion through state when region is provided", () => {
    const state = buildInitialGraphState(
      "Create an S3 bucket",
      "run-123",
      "eu-west-1",
    );

    expect(state["userIntent"]).toBe("Create an S3 bucket");
    expect(state["runId"]).toBe("run-123");
    expect(state["executionMode"]).toBe(ExecutionMode.PLAN);
    expect(state["noWizard"]).toBe(true);
    expect(state["bpEnforcementLevel"]).toBe(BPEnforcementLevel.ENFORCE);
    expect(state["awsRegion"]).toBe("eu-west-1");
    expect(typeof state["startedAt"]).toBe("number");
    expect(state["startedAt"] as number).toBeGreaterThan(0);
  });

  it("omits awsRegion entirely when region is undefined (concurrent-safe)", () => {
    const state = buildInitialGraphState(
      "Create a Lambda",
      "run-456",
      undefined,
    );

    expect("awsRegion" in state).toBe(false);
  });
});

describe("checkExecutionStatus", () => {
  it("continues for SUCCESS", () => {
    const result = checkExecutionStatus({
      [StateField.EXECUTION_STATUS]: ExecutionStatus.SUCCESS,
    });
    expect(result.kind).toBe("continue");
  });

  it("returns done with status=FAILED + explicit errorMessage", () => {
    const result = checkExecutionStatus({
      [StateField.EXECUTION_STATUS]: ExecutionStatus.FAILED,
      [StateField.ERROR_MESSAGE]: "AWS credentials are not configured",
    });

    expect(result.kind).toBe("done");
    if (result.kind !== "done") throw new Error("unreachable");
    const data = parseResponse(result.response);
    expect(result.response.isError).toBe(true);
    expect(data["error"]).toBe(true);
    expect(data["status"]).toBe(ExecutionStatus.FAILED);
    expect(data["message"]).toBe("AWS credentials are not configured");
    expect(data["hint"]).toBeUndefined();
  });

  it("falls back to PLAN_GENERATION_FAILED when errorMessage missing", () => {
    const result = checkExecutionStatus({
      [StateField.EXECUTION_STATUS]: ExecutionStatus.FAILED,
    });

    expect(result.kind).toBe("done");
    if (result.kind !== "done") throw new Error("unreachable");
    const data = parseResponse(result.response);
    expect(data["message"]).toBe(PLAN_GENERATION_FAILED);
  });

  it("attaches the MCP supported-types hint for UNSUPPORTED_RESOURCE", () => {
    const result = checkExecutionStatus({
      [StateField.EXECUTION_STATUS]: ExecutionStatus.UNSUPPORTED_RESOURCE,
      [StateField.ERROR_MESSAGE]:
        "Resource type 'AWS::Neptune::DBCluster' is not supported",
    });

    expect(result.kind).toBe("done");
    if (result.kind !== "done") throw new Error("unreachable");
    const data = parseResponse(result.response);
    expect(data["status"]).toBe(ExecutionStatus.UNSUPPORTED_RESOURCE);
    expect(typeof data["hint"]).toBe("string");
    expect(data["hint"] as string).toContain("Supported types");
  });
});

describe("buildUnexpectedErrorResponse", () => {
  it("wraps Error instances with their message and INTERNAL_ERROR status", () => {
    const response = buildUnexpectedErrorResponse(
      new Error("Connection timeout"),
    );

    const data = parseResponse(response);
    expect(response.isError).toBe(true);
    expect(data["error"]).toBe(true);
    expect(data["status"]).toBe("INTERNAL_ERROR");
    expect(data["message"]).toBe(
      "Unexpected error during plan generation: Connection timeout",
    );
  });

  it("stringifies non-Error values (defensive catch path)", () => {
    const response = buildUnexpectedErrorResponse("string failure");
    const data = parseResponse(response);
    expect(data["message"]).toBe(
      "Unexpected error during plan generation: string failure",
    );
  });
});
