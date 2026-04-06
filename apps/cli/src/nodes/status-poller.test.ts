import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  updateResource: ReturnType<typeof vi.fn>;
} {
  return {
    getResource: vi.fn(),
    createResource: vi.fn(),
    getRequestStatus: vi.fn(),
    deleteResource: vi.fn(),
    updateResource: vi.fn(),
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
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Helper: invoke the SUT (which contains an internal `await setTimeout(2000)`
 * before the provisioner call) under fake timers. We kick off the call,
 * advance the fake clock past the 2-second poll interval, and then await
 * the original promise so the SUT continues past the sleep.
 */
async function runPoller(
  state: Parameters<typeof statusPollerNode>[0],
  provisioner: ProvisioningPort,
): Promise<Awaited<ReturnType<typeof statusPollerNode>>> {
  const promise = statusPollerNode(state, provisioner);
  // Advance past the 2s POLL_INTERVAL_MS sleep.
  await vi.advanceTimersByTimeAsync(2_000);
  return promise;
}

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

  it("uses extended 15-minute timeout for RDS", async () => {
    // 6 minutes in — would timeout for S3 but NOT for RDS
    mockProvisioner.getRequestStatus.mockResolvedValueOnce([
      null,
      {
        operationStatus: "IN_PROGRESS",
        identifier: undefined,
        statusMessage: undefined,
      },
    ]);

    const result = await runPoller(
      makeState({
        resourceType: "AWS::RDS::DBInstance",
        startedAt: Date.now() - 6 * 60 * 1000,
      }),
      mockProvisioner,
    );

    expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
    expect(mockProvisioner.getRequestStatus).toHaveBeenCalled();
  });

  it("times out RDS after 15 minutes", async () => {
    const result = await statusPollerNode(
      makeState({
        resourceType: "AWS::RDS::DBInstance",
        startedAt: Date.now() - 16 * 60 * 1000,
      }),
      mockProvisioner,
    );
    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/timed out after 15 minutes/);
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

    const result = await runPoller(makeState(), mockProvisioner);

    expect(result.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
    expect(result.resourceArn).toBeUndefined();
    expect(mockProvisioner.getRequestStatus).toHaveBeenCalledWith("tok-abc123");
  });

  it("returns SUCCESS with Identifier when OperationStatus is SUCCESS", async () => {
    mockProvisioner.getRequestStatus.mockResolvedValueOnce([
      null,
      {
        operationStatus: "SUCCESS",
        identifier: "poc-smoke-test",
        statusMessage: undefined,
      },
    ]);

    const result = await runPoller(makeState(), mockProvisioner);

    expect(result.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(result.resourceArn).toBe("poc-smoke-test");
  });

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

    const result = await runPoller(makeState(), mockProvisioner);

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/BucketAlreadyExists/);
  });

  it("returns FAILED with fallback message when FAILED and no StatusMessage", async () => {
    mockProvisioner.getRequestStatus.mockResolvedValueOnce([
      null,
      {
        operationStatus: "FAILED",
        identifier: undefined,
        statusMessage: undefined,
      },
    ]);

    const result = await runPoller(makeState(), mockProvisioner);

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/provisioning failed/);
  });

  it("returns FAILED when OperationStatus is CANCEL_COMPLETE", async () => {
    mockProvisioner.getRequestStatus.mockResolvedValueOnce([
      null,
      {
        operationStatus: "CANCEL_COMPLETE",
        identifier: undefined,
        statusMessage: undefined,
      },
    ]);

    const result = await runPoller(
      makeState({ resourceType: "AWS::IAM::Role" }),
      mockProvisioner,
    );

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/provisioning failed/);
  });

  it("returns FAILED with error message on polling error", async () => {
    mockProvisioner.getRequestStatus.mockResolvedValueOnce([
      { kind: ProvisioningErrorKind.UNKNOWN, message: "Network timeout" },
      null,
    ]);

    const result = await runPoller(makeState(), mockProvisioner);

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/CloudControl polling failed/);
    expect(result.errorMessage).toMatch(/Network timeout/);
  });

  it("works for AWS::SSM::Parameter — returns SUCCESS with Identifier", async () => {
    mockProvisioner.getRequestStatus.mockResolvedValueOnce([
      null,
      {
        operationStatus: "SUCCESS",
        identifier: "/app/config/env",
        statusMessage: undefined,
      },
    ]);

    const result = await runPoller(
      makeState({
        requestToken: "tok-ssm-999",
        resourceType: "AWS::SSM::Parameter",
      }),
      mockProvisioner,
    );

    expect(result.executionStatus).toBe(ExecutionStatus.SUCCESS);
    expect(result.resourceArn).toBe("/app/config/env");
  });
});
