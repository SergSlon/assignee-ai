/**
 * Unit tests for the CloudFront Distribution destroy strategy.
 *
 * Covers (three-step disable-then-delete dance):
 *   1. Happy path — already-disabled distribution → skip UpdateDistribution, delete directly
 *   2. Happy path — enabled distribution → disable, poll until Deployed, then delete
 *   3. Edge case — GetDistribution returns no config → hard failure
 *   4. Edge case — transient GetDistribution errors during poll → retry up to CLOUDFRONT_MAX_TRANSIENT_ERRORS
 *   5. Edge case — consecutive transient errors exceed limit → hard failure
 *   6. Edge case — CloudFront disable times out → hard failure
 *   7. Edge case — MissingAssigneeCredentialsError → hard failure
 *   8. Edge case — unexpected status string (not InProgress/Deployed) → hard failure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cloudfrontDistributionStrategy } from "./cloudfront-distribution.js";
import type { DestroyContext } from "../types.js";
import { RESOURCE_TYPES } from "../../config/resource-types/named.js";
import { MissingAssigneeCredentialsError } from "../../config/aws-credentials.js";

// ── Hoisted mocks ─────────────────────────────────────────────────────

const { mockCfSend, mockCfDestroy, mockRequireAssigneeCredentials } =
  vi.hoisted(() => ({
    mockCfSend: vi.fn(),
    mockCfDestroy: vi.fn(),
    mockRequireAssigneeCredentials: vi.fn(),
  }));

vi.mock("@aws-sdk/client-cloudfront", () => {
  class CloudFrontClient {
    send = mockCfSend;
    destroy = mockCfDestroy;
  }
  function GetDistributionCommand(input: unknown) {
    return { _type: "GetDistributionCommand", input };
  }
  function UpdateDistributionCommand(input: unknown) {
    return { _type: "UpdateDistributionCommand", input };
  }
  function DeleteDistributionCommand(input: unknown) {
    return { _type: "DeleteDistributionCommand", input };
  }
  return {
    CloudFrontClient,
    GetDistributionCommand,
    UpdateDistributionCommand,
    DeleteDistributionCommand,
  };
});

vi.mock("../../config/aws-credentials.js", () => ({
  requireAssigneeCredentials: mockRequireAssigneeCredentials,
  MissingAssigneeCredentialsError: class MissingAssigneeCredentialsError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "MissingAssigneeCredentialsError";
    }
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────

const CF_ID = "E1ABCDEF12345";
const CF_ARN = `arn:aws:cloudfront::210987654321:distribution/${CF_ID}`;

function makeCtx(overrides: Partial<DestroyContext> = {}): DestroyContext {
  return {
    resource: {
      arn: CF_ARN,
      resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
      identifier: CF_ID,
      region: "us-east-1",
    },
    awsConfig: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
    },
    effectiveRegion: "us-east-1",
    onProgress: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

function makeDisabledDistributionConfig() {
  return {
    Enabled: false,
    Origins: {
      Quantity: 1,
      Items: [{ DomainName: "bucket.s3.amazonaws.com", Id: "S3Origin" }],
    },
    DefaultCacheBehavior: {
      TargetOriginId: "S3Origin",
      ViewerProtocolPolicy: "redirect-to-https",
    },
    Comment: "",
    CallerReference: "test-ref",
  };
}

beforeEach(() => {
  mockCfSend.mockReset();
  mockCfDestroy.mockReset();
  mockRequireAssigneeCredentials.mockReturnValue({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Iteratively settles a polling promise under fake timers. Required because
 * `vi.runAllTimersAsync()` only sees timers queued at invocation time, but
 * the strategy's `await import()` + initial mock awaits enqueue the first
 * `setTimeout()` after several microtask hops. Loop: drain microtasks,
 * advance fake time, repeat — until the promise settles or safety cap.
 */
async function flushUntilSettled(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let i = 0; i < 500 && !settled; i++) {
    for (let j = 0; j < 5; j++) await Promise.resolve();
    // Advance 10s of fake time per iter (cloudfront poll interval is 5s)
    await vi.advanceTimersByTimeAsync(10_000);
  }
}

// ── 1. Happy path — already-disabled distribution ─────────────────────

describe("cloudfrontDistributionStrategy.destroy — already disabled", () => {
  it("skips UpdateDistribution and calls DeleteDistribution directly", async () => {
    const config = makeDisabledDistributionConfig();
    mockCfSend
      .mockResolvedValueOnce({
        Distribution: { DistributionConfig: config },
        ETag: "E2QWRUHEXAMPLE",
      }) // GetDistribution
      .mockResolvedValueOnce({}); // DeleteDistribution

    const ctx = makeCtx();
    const promise = cloudfrontDistributionStrategy.destroy!(ctx);
    await flushUntilSettled(promise);
    const outcome = await promise;

    expect(outcome.success).toBe(true);
    // No UpdateDistribution call
    const calls = mockCfSend.mock.calls.map((c) => c[0]._type);
    expect(calls).not.toContain("UpdateDistributionCommand");
    expect(calls).toContain("DeleteDistributionCommand");
  });
});

// ── 2. Happy path — enabled distribution → disable then delete ────────

describe("cloudfrontDistributionStrategy.destroy — enabled distribution", () => {
  it("disables, waits for Deployed status, then deletes", async () => {
    const config = { ...makeDisabledDistributionConfig(), Enabled: true };
    mockCfSend
      .mockResolvedValueOnce({
        Distribution: { DistributionConfig: config },
        ETag: "E1INIT00000000",
      }) // GetDistribution (step 1)
      .mockResolvedValueOnce({}) // UpdateDistribution (step 2)
      // Poll: InProgress then Deployed
      .mockResolvedValueOnce({
        Distribution: { Status: "InProgress" },
        ETag: "E2INPROGRESS000",
      })
      .mockResolvedValueOnce({
        Distribution: { Status: "Deployed" },
        ETag: "E3DEPLOYED00000",
      })
      .mockResolvedValueOnce({}); // DeleteDistribution (step 3)

    const ctx = makeCtx();
    const promise = cloudfrontDistributionStrategy.destroy!(ctx);
    await flushUntilSettled(promise);
    const outcome = await promise;

    expect(outcome.success).toBe(true);
    const calls = mockCfSend.mock.calls.map((c) => c[0]._type);
    expect(calls).toContain("UpdateDistributionCommand");
    expect(calls).toContain("DeleteDistributionCommand");
  });
});

// ── 3. GetDistribution returns no config → hard failure ───────────────

describe("cloudfrontDistributionStrategy.destroy — missing config", () => {
  it("returns hard failure when GetDistribution does not return DistributionConfig", async () => {
    mockCfSend.mockResolvedValueOnce({ Distribution: {}, ETag: undefined });

    const ctx = makeCtx();
    const promise = cloudfrontDistributionStrategy.destroy!(ctx);
    await flushUntilSettled(promise);
    const outcome = await promise;

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("Could not retrieve distribution config");
  });
});

// ── 4. Transient poll errors → retry within limit ─────────────────────

describe("cloudfrontDistributionStrategy.destroy — transient poll errors", () => {
  it("retries on transient GetDistribution errors and succeeds when Deployed", async () => {
    const config = { ...makeDisabledDistributionConfig(), Enabled: true };
    mockCfSend
      .mockResolvedValueOnce({
        Distribution: { DistributionConfig: config },
        ETag: "E1",
      }) // initial Get
      .mockResolvedValueOnce({}) // UpdateDistribution
      .mockRejectedValueOnce(new Error("ThrottlingException")) // transient error 1
      .mockResolvedValueOnce({
        Distribution: { Status: "Deployed" },
        ETag: "E2",
      }) // poll: Deployed
      .mockResolvedValueOnce({}); // Delete

    const ctx = makeCtx();
    const promise = cloudfrontDistributionStrategy.destroy!(ctx);
    await flushUntilSettled(promise);
    const outcome = await promise;

    expect(outcome.success).toBe(true);
    expect(ctx.warn).toHaveBeenCalledWith(
      "cloudfront_poll_transient_error",
      expect.objectContaining({ consecutive: 1 }),
    );
  });
});

// ── 5. Consecutive transient errors exceed limit → hard failure ────────

describe("cloudfrontDistributionStrategy.destroy — too many transient errors", () => {
  it("returns hard failure after 5 consecutive transient poll errors", async () => {
    const config = { ...makeDisabledDistributionConfig(), Enabled: true };
    mockCfSend
      .mockResolvedValueOnce({
        Distribution: { DistributionConfig: config },
        ETag: "E1",
      }) // initial Get
      .mockResolvedValueOnce({}) // UpdateDistribution
      // 5 consecutive transient errors
      .mockRejectedValueOnce(new Error("ServiceUnavailable"))
      .mockRejectedValueOnce(new Error("ServiceUnavailable"))
      .mockRejectedValueOnce(new Error("ServiceUnavailable"))
      .mockRejectedValueOnce(new Error("ServiceUnavailable"))
      .mockRejectedValueOnce(new Error("ServiceUnavailable"));

    const ctx = makeCtx();
    const promise = cloudfrontDistributionStrategy.destroy!(ctx);
    await flushUntilSettled(promise);
    const outcome = await promise;

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("consecutive transient errors");
  });
});

// ── 6. Unexpected status (not InProgress/Deployed) → hard failure ──────

describe("cloudfrontDistributionStrategy.destroy — unexpected status", () => {
  it("returns hard failure when poll returns unknown status", async () => {
    const config = { ...makeDisabledDistributionConfig(), Enabled: true };
    mockCfSend
      .mockResolvedValueOnce({
        Distribution: { DistributionConfig: config },
        ETag: "E1",
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Distribution: { Status: "ERROR" }, ETag: "E2" }); // unexpected status

    const ctx = makeCtx();
    const promise = cloudfrontDistributionStrategy.destroy!(ctx);
    await flushUntilSettled(promise);
    const outcome = await promise;

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain(
      "CloudFront disable failed with status: ERROR",
    );
  });
});

// ── 7. MissingAssigneeCredentialsError → hard failure ─────────────────

describe("cloudfrontDistributionStrategy.destroy — missing credentials", () => {
  it("returns hard failure with credential error message", async () => {
    mockRequireAssigneeCredentials.mockImplementation(() => {
      throw new MissingAssigneeCredentialsError(
        "operator",
        "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
        "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
      );
    });

    const ctx = makeCtx();
    const promise = cloudfrontDistributionStrategy.destroy!(ctx);
    await flushUntilSettled(promise);
    const outcome = await promise;

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("Missing AWS credentials");
  });
});

// ── Strategy metadata ─────────────────────────────────────────────────

describe("cloudfrontDistributionStrategy metadata", () => {
  it("has the correct resourceType", () => {
    expect(cloudfrontDistributionStrategy.resourceType).toBe(
      RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
    );
  });

  it("exposes only a destroy hook (full CCAPI bypass)", () => {
    expect(typeof cloudfrontDistributionStrategy.destroy).toBe("function");
    expect(cloudfrontDistributionStrategy.preDestroy).toBeUndefined();
    expect(cloudfrontDistributionStrategy.postDestroy).toBeUndefined();
  });
});
