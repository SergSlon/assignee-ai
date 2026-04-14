import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExecutionStatus } from "@assignee/core";
import {
  statusPollerNode,
  isRetryableCloudFrontS3Error,
} from "./status-poller.js";
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

  it("times out RDS after 20 minutes", async () => {
    const result = await statusPollerNode(
      makeState({
        resourceType: "AWS::RDS::DBInstance",
        startedAt: Date.now() - 21 * 60 * 1000,
      }),
      mockProvisioner,
    );
    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toMatch(/timed out after 20 minutes/);
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

  // ── H10 regression: startedAt-undefined must FAIL fast ────────────────────
  it("H10: fails fast when startedAt is undefined (no silent Date.now() fallback)", async () => {
    // This is the bug that produced an infinite poll loop: on a self-looping
    // LangGraph node, if startedAt was ever missing on re-entry the previous
    // implementation would `?? Date.now()`, which reset the wall-clock budget
    // every iteration and made the timeout guard impossible to hit.
    const result = await statusPollerNode(
      makeState({ startedAt: undefined }),
      mockProvisioner,
    );
    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toBe(
      "status_poller invoked without startedAt — graph state is corrupt",
    );
    // Crucially: we must NOT have called the AWS provisioner — the corrupt
    // state is detected before any I/O.
    expect(mockProvisioner.getRequestStatus).not.toHaveBeenCalled();
  });

  // ── H10 adjacent: dead MAX_POLL_ITERATIONS guard removed ──────────────────
  it("H10: wall-clock timeout is the sole runaway-loop guard (dead iteration guard removed)", async () => {
    // Previously a MAX_POLL_ITERATIONS=450 guard divided wall-clock by
    // POLL_INTERVAL_MS (2s) to estimate iterations. Because each real
    // iteration waits POLL_INTERVAL_MS + AWS RTT, the counter always
    // under-counted reality and the wall-clock guard fired first — the
    // iteration guard was dead code. We removed it; this test pins the
    // contract that the wall-clock guard alone catches a runaway loop:
    //
    //   - Just under default timeout (5min - 1s): poll proceeds normally.
    //   - Just over default timeout (5min + 1s): FAILED with the wall-clock
    //     timeout message (NOT an iteration-count message).
    mockProvisioner.getRequestStatus.mockResolvedValueOnce([
      null,
      {
        operationStatus: "IN_PROGRESS",
        identifier: undefined,
        statusMessage: undefined,
      },
    ]);
    const justUnder = await runPoller(
      makeState({ startedAt: Date.now() - (5 * 60 * 1000 - 1_000) }),
      mockProvisioner,
    );
    expect(justUnder.executionStatus).toBe(ExecutionStatus.IN_PROGRESS);
    expect(mockProvisioner.getRequestStatus).toHaveBeenCalledTimes(1);

    const justOver = await statusPollerNode(
      makeState({ startedAt: Date.now() - (5 * 60 * 1000 + 1_000) }),
      mockProvisioner,
    );
    expect(justOver.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(justOver.errorMessage).toMatch(/timed out after 5 minutes/);
    // The old dead guard's error string mentioned "poll iterations" — make
    // sure no such message can ever come back.
    expect(justOver.errorMessage).not.toMatch(/poll iterations/);
    // No additional provisioner call from the over-timeout invocation.
    expect(mockProvisioner.getRequestStatus).toHaveBeenCalledTimes(1);
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

// ── isRetryableCloudFrontS3Error helper ───────────────────────────────────
//
// CCAPI's async CloudFront origin validator can fail when a just-created S3
// bucket hasn't propagated through global DNS yet. The helper classifies
// the FAILED statusMessage so the poller can retry up to MAX_CLOUDFRONT_RETRIES
// instead of surfacing a confusing 30s "no such bucket" failure to the
// user. Closes QA BLOCKER B2: the helper landed in commit 8c658eb /
// 6a3f6b5 with no unit coverage; a regex regression here would silently
// turn every CloudFront-with-S3-origin into a one-shot failure.
//
// Each pattern below corresponds to a real CCAPI response observed in the
// 2026-04 e2e runs — see the inline comments in status-poller.ts for the
// raw error strings.
describe("isRetryableCloudFrontS3Error", () => {
  it("returns false for an empty status message", () => {
    expect(isRetryableCloudFrontS3Error("")).toBe(false);
  });

  it("matches the synchronous 'does not refer to a valid S3 bucket' shape", () => {
    expect(
      isRetryableCloudFrontS3Error(
        "The parameter Origin DomainName does not refer to a valid S3 bucket",
      ),
    ).toBe(true);
  });

  it("matches the 'one or more of your origins ... does not exist' shape", () => {
    expect(
      isRetryableCloudFrontS3Error(
        "One or more of your origins or origin groups does not exist",
      ),
    ).toBe(true);
  });

  it("matches the 'S3 bucket ... does not exist' shape", () => {
    expect(
      isRetryableCloudFrontS3Error(
        "The S3 bucket assignee-ci-1712948112-static does not exist",
      ),
    ).toBe(true);
  });

  it("matches the bare 'NoSuchBucket' AWS error code", () => {
    expect(isRetryableCloudFrontS3Error("NoSuchBucket")).toBe(true);
  });

  it("matches the case-insensitive variant", () => {
    // The helper lower-cases the input, so an upper-case error code
    // from a CCAPI rollback should still classify as retryable.
    expect(isRetryableCloudFrontS3Error("NOSUCHBUCKET")).toBe(true);
  });

  it("matches the 'InvalidOrigin' generic origin validation failure", () => {
    expect(isRetryableCloudFrontS3Error("InvalidOrigin")).toBe(true);
  });

  it("matches the 's3 origin' substring path", () => {
    expect(
      isRetryableCloudFrontS3Error(
        "S3 origin returned an unexpected error code",
      ),
    ).toBe(true);
  });

  it("matches the 'origin ... not found' co-occurrence path", () => {
    expect(
      isRetryableCloudFrontS3Error(
        "The origin assignee-ci-1712948112-static.s3.amazonaws.com was not found",
      ),
    ).toBe(true);
  });

  it("matches origin+domainname+s3 co-occurrence", () => {
    expect(
      isRetryableCloudFrontS3Error(
        "Origin DomainName must be a valid s3 endpoint",
      ),
    ).toBe(true);
  });

  it("matches the CCAPI rollback 'CloudFront::Distribution ... was not found' shape", () => {
    expect(
      isRetryableCloudFrontS3Error(
        "Resource of type 'AWS::CloudFront::Distribution' with identifier 'E12ABCDEF34GHI' was not found.",
      ),
    ).toBe(true);
  });

  it("returns false for an unrelated CloudFront config error (no retry)", () => {
    // Config errors must NOT be retried — they would never resolve and
    // would burn the 3-attempt retry budget on a guaranteed failure.
    expect(
      isRetryableCloudFrontS3Error(
        "InvalidArgument: The default cache behavior is missing required field TargetOriginId",
      ),
    ).toBe(false);
  });

  it("returns false for an unrelated AccessDenied error", () => {
    expect(
      isRetryableCloudFrontS3Error(
        "AccessDenied: User is not authorized to perform cloudfront:CreateDistribution",
      ),
    ).toBe(false);
  });

  it("returns false for an empty CCAPI 200 response", () => {
    // Defensive: the poller occasionally sees empty statusMessage on
    // success — must never classify as retryable.
    expect(isRetryableCloudFrontS3Error(" ")).toBe(false);
  });
});
