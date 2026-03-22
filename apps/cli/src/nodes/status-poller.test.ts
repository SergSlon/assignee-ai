import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionStatus } from "@assignee/core";
import { statusPollerNode } from "./status-poller.js";
import {
  ProvisioningErrorKind,
  type ProvisioningPort,
} from "../services/provisioning-port.js";

// ── Mock provisioning port ──────────────────────────────────────────────────

function createMockProvisioner(): ProvisioningPort & {
  getResource: ReturnType<typeof vi.fn>;
  createResource: ReturnType<typeof vi.fn>;
  getRequestStatus: ReturnType<typeof vi.fn>;
  deleteResource: ReturnType<typeof vi.fn>;
} {
  return {
    getResource: vi.fn(),
    createResource: vi.fn(),
    getRequestStatus: vi.fn(),
    deleteResource: vi.fn(),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let mockProvisioner: ReturnType<typeof createMockProvisioner>;

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
  mockProvisioner = createMockProvisioner();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("statusPollerNode", () => {
  it("fails immediately when requestToken is missing", async () => {
    const result = await statusPollerNode(
      makeState({ requestToken: undefined }),
      mockProvisioner,
    );
    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/No request token/);
    expect(mockProvisioner.getRequestStatus).not.toHaveBeenCalled();
  });

  it("fails when startedAt exceeds 5-minute timeout", async () => {
    const result = await statusPollerNode(
      makeState({ startedAt: Date.now() - 6 * 60 * 1000 }),
      mockProvisioner,
    );
    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/timed out/);
    expect(mockProvisioner.getRequestStatus).not.toHaveBeenCalled();
  });

  it("returns IN_PROGRESS for IN_PROGRESS OperationStatus", async () => {
    mockProvisioner.getRequestStatus.mockResolvedValueOnce([
      null,
      {
        operationStatus: "IN_PROGRESS",
        identifier: undefined,
        statusMessage: undefined,
      },
    ]);

    const result = await statusPollerNode(makeState(), mockProvisioner);

    expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
    expect(result.resourceArn).toBeUndefined();
    expect(mockProvisioner.getRequestStatus).toHaveBeenCalledWith("tok-abc123");
  }, 5000);

  it("returns SUCCESS with Identifier when OperationStatus is SUCCESS", async () => {
    mockProvisioner.getRequestStatus.mockResolvedValueOnce([
      null,
      {
        operationStatus: "SUCCESS",
        identifier: "poc-smoke-test",
        statusMessage: undefined,
      },
    ]);

    const result = await statusPollerNode(makeState(), mockProvisioner);

    expect(result.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(result.resourceArn).toBe("poc-smoke-test");
  }, 5000);

  it("returns FAILED with StatusMessage when OperationStatus is FAILED", async () => {
    mockProvisioner.getRequestStatus.mockResolvedValueOnce([
      null,
      {
        operationStatus: "FAILED",
        identifier: undefined,
        statusMessage:
          'Resource handler returned message: "BucketAlreadyExists" (HandlerErrorCode: AlreadyExists)',
      },
    ]);

    const result = await statusPollerNode(makeState(), mockProvisioner);

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/BucketAlreadyExists/);
  }, 5000);

  it("returns FAILED with fallback message when FAILED and no StatusMessage", async () => {
    mockProvisioner.getRequestStatus.mockResolvedValueOnce([
      null,
      {
        operationStatus: "FAILED",
        identifier: undefined,
        statusMessage: undefined,
      },
    ]);

    const result = await statusPollerNode(makeState(), mockProvisioner);

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/provisioning failed/);
  }, 5000);

  it("returns FAILED when OperationStatus is CANCEL_COMPLETE", async () => {
    mockProvisioner.getRequestStatus.mockResolvedValueOnce([
      null,
      {
        operationStatus: "CANCEL_COMPLETE",
        identifier: undefined,
        statusMessage: undefined,
      },
    ]);

    const result = await statusPollerNode(
      makeState({ resourceType: "AWS::IAM::Role" }),
      mockProvisioner,
    );

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/provisioning failed/);
  }, 5000);

  it("returns FAILED with error message on polling error", async () => {
    mockProvisioner.getRequestStatus.mockResolvedValueOnce([
      { kind: ProvisioningErrorKind.UNKNOWN, message: "Network timeout" },
      null,
    ]);

    const result = await statusPollerNode(makeState(), mockProvisioner);

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/CloudControl polling failed/);
    expect(result.errorMessage).toMatch(/Network timeout/);
  }, 5000);

  it("works for AWS::SSM::Parameter — returns SUCCESS with Identifier", async () => {
    mockProvisioner.getRequestStatus.mockResolvedValueOnce([
      null,
      {
        operationStatus: "SUCCESS",
        identifier: "/app/config/env",
        statusMessage: undefined,
      },
    ]);

    const result = await statusPollerNode(
      makeState({
        requestToken: "tok-ssm-999",
        resourceType: "AWS::SSM::Parameter",
      }),
      mockProvisioner,
    );

    expect(result.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(result.resourceArn).toBe("/app/config/env");
  }, 5000);
});
