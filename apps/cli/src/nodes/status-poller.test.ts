import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionStatus } from "@assignee/core";
import { statusPollerNode } from "./status-poller.js";
import type { StructuredTool } from "@langchain/core/tools";

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    userIntent: "Create an S3 bucket",
    runId: "run-test-789",
    executionStatus: ExecutionStatus.IN_PROGRESS,
    executionMode: "apply",
    resourceType: "AWS::S3::Bucket",
    resourceSchema: undefined,
    desiredState: undefined,
    estimatedMonthlyCost: undefined,
    requestToken: "tok-abc123",
    resourceArn: undefined,
    errorMessage: undefined,
    startedAt: Date.now(),
    messages: [],
    preflightPassed: true,
    preflightErrors: [],
    preflightMode: "local",
    ...overrides,
  } as unknown as Parameters<typeof statusPollerNode>[0];
}

function makeStatusTool(response: unknown): StructuredTool {
  return {
    name: "get_resource_request_status",
    invoke: vi.fn().mockResolvedValue(response),
  } as unknown as StructuredTool;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("statusPollerNode", () => {
  it("fails immediately when requestToken is missing", async () => {
    const result = await statusPollerNode(
      makeState({ requestToken: undefined }),
    );
    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/No request token/);
  });

  it("fails immediately when status tool is not available", async () => {
    const result = await statusPollerNode(makeState(), []);
    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/ccapi-mcp-server not available/);
  });

  it("fails when startedAt exceeds 5-minute timeout", async () => {
    const tool = makeStatusTool({
      type: "text",
      text: JSON.stringify({ status: "IN_PROGRESS", is_complete: false }),
    });
    const result = await statusPollerNode(
      makeState({ startedAt: Date.now() - 6 * 60 * 1000 }),
      [tool],
    );
    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/timed out/);
    expect(tool.invoke).not.toHaveBeenCalled();
  });

  it("parses real IN_PROGRESS MCP response and returns IN_PROGRESS", async () => {
    // Real response shape returned by ccapi-mcp-server get_resource_request_status.
    // Captured from a live call during S3 bucket creation — operation still running.
    const realMcpResponse = {
      type: "text",
      text: JSON.stringify({
        status: "IN_PROGRESS",
        is_complete: false,
        request_token: "tok-abc123",
        operation: "CREATE",
        resource_type: "AWS::S3::Bucket",
      }),
    };

    const tool = makeStatusTool(realMcpResponse);
    const result = await statusPollerNode(makeState(), [tool]);

    expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
    expect(result.resourceArn).toBeUndefined();
    expect(tool.invoke).toHaveBeenCalledWith({ request_token: "tok-abc123" });
  }, 5000);

  it("parses real SUCCESS MCP response and returns SUCCESS with identifier", async () => {
    // Real response shape returned by ccapi-mcp-server get_resource_request_status.
    // Captured from a live call after S3 bucket creation completed successfully.
    const realMcpResponse = {
      type: "text",
      text: JSON.stringify({
        status: "SUCCESS",
        is_complete: true,
        request_token: "tok-abc123",
        operation: "CREATE",
        resource_type: "AWS::S3::Bucket",
        resource_identifier: "poc-smoke-test",
      }),
    };

    const tool = makeStatusTool(realMcpResponse);
    const result = await statusPollerNode(makeState(), [tool]);

    expect(result.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(result.resourceArn).toBe("poc-smoke-test");
  }, 5000);

  it("parses SUCCESS via is_complete flag even when status field is absent", async () => {
    // Some ccapi-mcp-server versions only set is_complete without a status string.
    const realMcpResponse = {
      type: "text",
      text: JSON.stringify({
        is_complete: true,
        request_token: "tok-abc123",
        resource_type: "AWS::SSM::Parameter",
        resource_identifier: "/app/config/env",
      }),
    };

    const tool = makeStatusTool(realMcpResponse);
    const result = await statusPollerNode(
      makeState({ resourceType: "AWS::SSM::Parameter" }),
      [tool],
    );

    expect(result.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(result.resourceArn).toBe("/app/config/env");
  }, 5000);

  it("parses real FAILED MCP response and returns FAILED with error_message", async () => {
    // Real response shape returned by ccapi-mcp-server when creation fails.
    const realMcpResponse = {
      type: "text",
      text: JSON.stringify({
        status: "FAILED",
        is_complete: true,
        request_token: "tok-abc123",
        operation: "CREATE",
        resource_type: "AWS::S3::Bucket",
        error_message:
          'Resource handler returned message: "BucketAlreadyExists" (HandlerErrorCode: AlreadyExists)',
      }),
    };

    const tool = makeStatusTool(realMcpResponse);
    const result = await statusPollerNode(makeState(), [tool]);

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/BucketAlreadyExists/);
  }, 5000);

  it("parses CANCEL_COMPLETE status and returns FAILED", async () => {
    const realMcpResponse = {
      type: "text",
      text: JSON.stringify({
        status: "CANCEL_COMPLETE",
        is_complete: true,
        request_token: "tok-abc123",
        resource_type: "AWS::IAM::Role",
      }),
    };

    const tool = makeStatusTool(realMcpResponse);
    const result = await statusPollerNode(
      makeState({ resourceType: "AWS::IAM::Role" }),
      [tool],
    );

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/provisioning failed/);
  }, 5000);

  it("handles plain JSON string response (no text wrapper)", async () => {
    // Some MCP server versions return a raw JSON string directly.
    const plainStringResponse = JSON.stringify({
      status: "SUCCESS",
      is_complete: true,
      request_token: "tok-abc123",
      resource_identifier: "my-ssm-param",
    });

    const tool = makeStatusTool(plainStringResponse);
    const result = await statusPollerNode(makeState(), [tool]);

    expect(result.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(result.resourceArn).toBe("my-ssm-param");
  }, 5000);

  it("returns FAILED on tool invoke error", async () => {
    const tool = {
      name: "get_resource_request_status",
      invoke: vi.fn().mockRejectedValue(new Error("Network timeout")),
    } as unknown as StructuredTool;

    const result = await statusPollerNode(makeState(), [tool]);

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/Network timeout/);
  }, 5000);
});
