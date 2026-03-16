import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionStatus } from "@assignee/core";

// ── SDK mock ──────────────────────────────────────────────────────────────────
const mockSend = vi.fn();

vi.mock("../services/cloudcontrol-client.js", () => ({
  getCloudControlClient: () => ({ send: mockSend }),
}));

vi.mock("@aws-sdk/client-cloudcontrol", () => ({
  CloudControlClient: vi.fn(),
  GetResourceRequestStatusCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ input })),
}));

import { statusPollerNode } from "./status-poller.js";
import { GetResourceRequestStatusCommand } from "@aws-sdk/client-cloudcontrol";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("statusPollerNode", () => {
  it("fails immediately when requestToken is missing", async () => {
    const result = await statusPollerNode(
      makeState({ requestToken: undefined }),
    );
    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/No request token/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("fails when startedAt exceeds 5-minute timeout", async () => {
    const result = await statusPollerNode(
      makeState({ startedAt: Date.now() - 6 * 60 * 1000 }),
    );
    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/timed out/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("returns IN_PROGRESS for IN_PROGRESS OperationStatus", async () => {
    mockSend.mockResolvedValueOnce({
      ProgressEvent: {
        RequestToken: "tok-abc123",
        OperationStatus: "IN_PROGRESS",
        TypeName: "AWS::S3::Bucket",
      },
    });

    const result = await statusPollerNode(makeState());

    expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
    expect(result.resourceArn).toBeUndefined();
    expect(GetResourceRequestStatusCommand).toHaveBeenCalledWith({
      RequestToken: "tok-abc123",
    });
  }, 5000);

  it("returns SUCCESS with Identifier when OperationStatus is SUCCESS", async () => {
    mockSend.mockResolvedValueOnce({
      ProgressEvent: {
        RequestToken: "tok-abc123",
        OperationStatus: "SUCCESS",
        TypeName: "AWS::S3::Bucket",
        Identifier: "poc-smoke-test",
      },
    });

    const result = await statusPollerNode(makeState());

    expect(result.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(result.resourceArn).toBe("poc-smoke-test");
  }, 5000);

  it("returns FAILED with StatusMessage when OperationStatus is FAILED", async () => {
    mockSend.mockResolvedValueOnce({
      ProgressEvent: {
        RequestToken: "tok-abc123",
        OperationStatus: "FAILED",
        TypeName: "AWS::S3::Bucket",
        StatusMessage:
          'Resource handler returned message: "BucketAlreadyExists" (HandlerErrorCode: AlreadyExists)',
      },
    });

    const result = await statusPollerNode(makeState());

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/BucketAlreadyExists/);
  }, 5000);

  it("returns FAILED with fallback message when FAILED and no StatusMessage", async () => {
    mockSend.mockResolvedValueOnce({
      ProgressEvent: {
        RequestToken: "tok-abc123",
        OperationStatus: "FAILED",
        TypeName: "AWS::S3::Bucket",
      },
    });

    const result = await statusPollerNode(makeState());

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/provisioning failed/);
  }, 5000);

  it("returns FAILED when OperationStatus is CANCEL_COMPLETE", async () => {
    mockSend.mockResolvedValueOnce({
      ProgressEvent: {
        RequestToken: "tok-abc123",
        OperationStatus: "CANCEL_COMPLETE",
        TypeName: "AWS::IAM::Role",
      },
    });

    const result = await statusPollerNode(
      makeState({ resourceType: "AWS::IAM::Role" }),
    );

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/provisioning failed/);
  }, 5000);

  it("returns FAILED with error message on SDK send error", async () => {
    mockSend.mockRejectedValueOnce(new Error("Network timeout"));

    const result = await statusPollerNode(makeState());

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/CloudControl polling failed/);
    expect(result.errorMessage).toMatch(/Network timeout/);
  }, 5000);

  it("works for AWS::SSM::Parameter — returns SUCCESS with Identifier", async () => {
    mockSend.mockResolvedValueOnce({
      ProgressEvent: {
        RequestToken: "tok-ssm-999",
        OperationStatus: "SUCCESS",
        TypeName: "AWS::SSM::Parameter",
        Identifier: "/app/config/env",
      },
    });

    const result = await statusPollerNode(
      makeState({
        requestToken: "tok-ssm-999",
        resourceType: "AWS::SSM::Parameter",
      }),
    );

    expect(result.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(result.resourceArn).toBe("/app/config/env");
  }, 5000);
});
