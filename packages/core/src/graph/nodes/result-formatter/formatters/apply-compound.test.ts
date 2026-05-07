/**
 * W11-S0 (M-α-07): throttleRetryCount reset between compound resources.
 *
 * Regression test that pins the fix: when the mid-compound advance branch
 * returns the next-resource state update, `throttleRetryCount` must be 0.
 * Without the fix, resource N+1 inherits resource N's exhausted retry budget
 * and fails immediately on the first ThrottlingException.
 *
 * Invariants checked:
 *   1. Mid-compound advance from exhausted-budget resource → returned partial
 *      state has `throttleRetryCount === 0`.
 *   2. Terminal-success path (all resources done) → `throttleRetryCount` is
 *      NOT present in the returned state (no unnecessary field pollution).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionMode, ExecutionStatus } from "@/index.js";
import type { AgentState } from "@/graph/graph-state.js";

// ── Hoisted mocks for compensating policy ────────────────────────────────────
const { mockAttachCompensatingBucketPolicy, mockGetOperatorCallerArn } =
  vi.hoisted(() => ({
    mockAttachCompensatingBucketPolicy: vi
      .fn()
      .mockResolvedValue({ attached: true }),
    mockGetOperatorCallerArn: vi
      .fn()
      .mockResolvedValue("arn:aws:iam::112233445566:user/assignee-operator"),
  }));

vi.mock("@/services/s3-compensating-bucket-policy.js", () => ({
  attachCompensatingBucketPolicy: mockAttachCompensatingBucketPolicy,
}));

vi.mock("@/utils/resolve-arn.js", () => ({
  getOperatorCallerArn: mockGetOperatorCallerArn,
}));

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/utils/display.js", () => ({
  renderCompoundSuccess: vi.fn(),
}));

vi.mock("@/utils/logger/index.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    APPLY_SUCCEEDED: "APPLY_SUCCEEDED",
  },
}));

vi.mock("@/utils/security-posture.js", () => ({
  checkSecurityPosture: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/memory-recorder.js", () => ({
  writeProvisionRecord: vi.fn().mockResolvedValue(undefined),
  clearFailureHistory: vi.fn().mockResolvedValue(undefined),
  upsertPatternRecord: vi.fn().mockResolvedValue(undefined),
}));

// W14-S0: use vi.hoisted() so the mock function references are stable across
// tests. vitest.config has mockReset: true which wipes mock implementations
// between tests. Without hoisted refs + beforeEach restoration, the 4th test
// (terminal-success path) sees buildDisplayArnMap return undefined instead of
// {} and crashes with "Cannot read properties of undefined". The factory
// creates the functions once; beforeEach restores their implementations after
// each mockReset cycle.
const _arnDisplayMocks = vi.hoisted(() => ({
  resolveDisplayArn: vi.fn(),
  buildDisplayArnMap: vi.fn(),
}));

vi.mock("../arn-display.js", () => _arnDisplayMocks);

vi.mock("./static-site-upload.js", () => ({
  printStaticWebsiteCloudFrontUrl: vi.fn(),
  runStaticSiteUploadFor: vi.fn().mockResolvedValue(undefined),
}));

// ── Restore mock implementations after each mockReset cycle ──────────────────
//
// vitest.config has mockReset: true which wipes mock implementations between
// tests. Re-apply the expected return values here so every test (including
// the terminal-success test that calls buildDisplayArnMap) sees correct
// implementations.
beforeEach(() => {
  _arnDisplayMocks.resolveDisplayArn.mockResolvedValue(
    "arn:aws:ec2:us-east-1:210987654321:vpc/vpc-12345",
  );
  // buildDisplayArnMap returns a map keyed by resourceId → resourceArn.
  // For test purposes an empty map is sufficient: arnForRecord falls back
  // to completed.resourceArn which is always defined in the test fixtures.
  _arnDisplayMocks.buildDisplayArnMap.mockResolvedValue({});
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Two-resource compound queue modelled on a real VPC networking pattern.
 *   resource 0: VPC (gateway attachment)
 *   resource 1: Subnet (route table association)
 */
const twoResourceQueue = [
  {
    resourceId: "vpc-main",
    resourceType: "AWS::EC2::VPC",
    displayName: "Main VPC",
  },
  {
    resourceId: "subnet-public",
    resourceType: "AWS::EC2::Subnet",
    displayName: "Public Subnet",
  },
];

const mockPattern = {
  patternId: "vpc-networking",
  displayName: "VPC Networking",
  keywords: ["vpc"],
  resourceList: twoResourceQueue,
  dependencyOrder: [["vpc-main"], ["subnet-public"]],
  defaultOptions: {},
};

/** MAX_THROTTLE_RETRIES from status-poller (5). Replicated here as a constant
 *  so the test exercises the exact ceiling value that causes the bug. */
const MAX_THROTTLE_RETRIES = 5;

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "create a vpc",
    runId: "w11-s0-test-run",
    executionMode: ExecutionMode.APPLY,
    executionStatus: ExecutionStatus.SUCCESS,
    resourceType: "AWS::EC2::VPC",
    resourceArn: "vpc-abcdef01",
    resourcePattern: mockPattern as unknown as AgentState["resourcePattern"],
    resourceQueue: twoResourceQueue as unknown as AgentState["resourceQueue"],
    currentResourceIndex: 0,
    completedResources: [],
    throttleRetryCount: 0,
    preflightPassed: true,
    preflightErrors: [],
    preflightMode: "local",
    messages: [],
    ...overrides,
  } as AgentState;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("formatApplyCompoundSuccess — W11-S0 throttleRetryCount reset", () => {
  it("resets throttleRetryCount to 0 when advancing mid-compound (resource 0 → 1)", async () => {
    const { formatApplyCompoundSuccess } = await import("./apply-compound.js");

    const state = makeState({ throttleRetryCount: 0 });
    const result = await formatApplyCompoundSuccess(state);

    // Must advance to resource 1, still in-flight
    expect(result.currentResourceIndex).toBe(1);
    expect(result.executionStatus).toBe(ExecutionStatus.PENDING);
    // The core invariant: throttleRetryCount must be reset
    expect(result.throttleRetryCount).toBe(0);
  });

  it("resets throttleRetryCount to 0 even when resource 0 exhausted its full budget (throttleRetryCount === MAX)", async () => {
    const { formatApplyCompoundSuccess } = await import("./apply-compound.js");

    // Simulate resource 0 having hit the ceiling (5 retries)
    const state = makeState({ throttleRetryCount: MAX_THROTTLE_RETRIES });
    const result = await formatApplyCompoundSuccess(state);

    // Advance to resource 1
    expect(result.currentResourceIndex).toBe(1);
    expect(result.executionStatus).toBe(ExecutionStatus.PENDING);
    // Core invariant: resource 1 starts with a clean budget
    expect(result.throttleRetryCount).toBe(0);
  });

  it("resets throttleRetryCount to 0 for any non-zero mid-compound count (partial budget used)", async () => {
    const { formatApplyCompoundSuccess } = await import("./apply-compound.js");

    // Resource 0 used 3 of 5 retries
    const state = makeState({ throttleRetryCount: 3 });
    const result = await formatApplyCompoundSuccess(state);

    expect(result.currentResourceIndex).toBe(1);
    expect(result.executionStatus).toBe(ExecutionStatus.PENDING);
    expect(result.throttleRetryCount).toBe(0);
  });

  it("does NOT include throttleRetryCount in terminal-success return (all resources done)", async () => {
    const { formatApplyCompoundSuccess } = await import("./apply-compound.js");

    // currentResourceIndex points at the LAST resource (index 1 of 2-resource queue)
    const state = makeState({
      currentResourceIndex: 1,
      resourceType: "AWS::EC2::Subnet",
      resourceArn: "subnet-99887766",
      completedResources: [
        {
          resourceId: "vpc-main",
          resourceType: "AWS::EC2::VPC",
          resourceArn: "vpc-abcdef01",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
      throttleRetryCount: MAX_THROTTLE_RETRIES,
    });

    const result = await formatApplyCompoundSuccess(state);

    // Terminal path: only completedResources, no throttleRetryCount field
    expect(result.completedResources).toHaveLength(2);
    expect(
      Object.prototype.hasOwnProperty.call(result, "throttleRetryCount"),
    ).toBe(false);
  });
});

// ── Bug S3-001 Part 2 — compensating bucket policy in compound terminal SUCCESS
//
// When the terminal compound formatter runs, it must call
// attachCompensatingBucketPolicy for every S3 bucket in the completed set.
// The mid-compound advance branch (non-terminal) must NOT call it.
// Non-blocking: policy-attachment failures warn+log but do not fail the apply.
describe("formatApplyCompoundSuccess — S3 compensating bucket policy", () => {
  const S3_BUCKET_NAME = "assignee-static-site-2026";
  const OPERATOR_ARN = "arn:aws:iam::112233445566:user/assignee-operator";

  // A 2-resource queue ending with an S3 bucket.
  const s3Queue = [
    {
      resourceId: "cloudfront-dist",
      resourceType: "AWS::CloudFront::Distribution",
      displayName: "CDN Distribution",
    },
    {
      resourceId: "s3-bucket",
      resourceType: "AWS::S3::Bucket",
      displayName: "Static Site Bucket",
    },
  ];

  const s3Pattern = {
    patternId: "static-website",
    displayName: "Static Website",
    keywords: ["static"],
    resourceList: s3Queue,
    dependencyOrder: [["cloudfront-dist"], ["s3-bucket"]],
    defaultOptions: {},
  };

  beforeEach(() => {
    mockGetOperatorCallerArn.mockResolvedValue(OPERATOR_ARN);
    mockAttachCompensatingBucketPolicy.mockResolvedValue({ attached: true });
  });

  it("calls attachCompensatingBucketPolicy for the S3 bucket in terminal compound SUCCESS", async () => {
    const { formatApplyCompoundSuccess } = await import("./apply-compound.js");

    // Terminal success: currentResourceIndex points at the last resource.
    const state = makeState({
      currentResourceIndex: 1,
      resourceType: "AWS::S3::Bucket",
      resourceArn: S3_BUCKET_NAME,
      resourceQueue: s3Queue as unknown as AgentState["resourceQueue"],
      resourcePattern: s3Pattern as unknown as AgentState["resourcePattern"],
      completedResources: [
        {
          resourceId: "cloudfront-dist",
          resourceType: "AWS::CloudFront::Distribution",
          resourceArn: "E1ABCDEF123456",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
    });

    await formatApplyCompoundSuccess(state);

    expect(mockAttachCompensatingBucketPolicy).toHaveBeenCalledTimes(1);
    expect(mockAttachCompensatingBucketPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        bucketName: S3_BUCKET_NAME,
        operatorArn: OPERATOR_ARN,
      }),
    );
  });

  it("does NOT call attachCompensatingBucketPolicy on mid-compound advance (non-terminal)", async () => {
    const { formatApplyCompoundSuccess } = await import("./apply-compound.js");

    // Mid-compound: currentResourceIndex 0 → advancing to 1.
    const state = makeState({
      currentResourceIndex: 0,
      resourceType: "AWS::CloudFront::Distribution",
      resourceArn: "E1ABCDEF123456",
      resourceQueue: s3Queue as unknown as AgentState["resourceQueue"],
      resourcePattern: s3Pattern as unknown as AgentState["resourcePattern"],
      completedResources: [],
    });

    const result = await formatApplyCompoundSuccess(state);

    // Mid-compound: advances to next resource.
    expect(result.currentResourceIndex).toBe(1);
    // Compensating policy hook NOT called — bucket not yet created.
    expect(mockAttachCompensatingBucketPolicy).not.toHaveBeenCalled();
  });

  it("warns to stderr + logs when attachCompensatingBucketPolicy fails in compound — does NOT fail the apply", async () => {
    const { formatApplyCompoundSuccess } = await import("./apply-compound.js");
    mockAttachCompensatingBucketPolicy.mockResolvedValueOnce({
      attached: false,
      reason: "ThrottlingException",
    });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const state = makeState({
      currentResourceIndex: 1,
      resourceType: "AWS::S3::Bucket",
      resourceArn: S3_BUCKET_NAME,
      resourceQueue: s3Queue as unknown as AgentState["resourceQueue"],
      resourcePattern: s3Pattern as unknown as AgentState["resourcePattern"],
      completedResources: [
        {
          resourceId: "cloudfront-dist",
          resourceType: "AWS::CloudFront::Distribution",
          resourceArn: "E1ABCDEF123456",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
    });

    const result = await formatApplyCompoundSuccess(state);

    // Apply still completes.
    expect(result.completedResources).toHaveLength(2);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Compensating bucket policy could not be attached",
      ),
    );

    stderrSpy.mockRestore();
  });

  it("skips policy attachment when operator ARN is unavailable and logs the skip", async () => {
    const { formatApplyCompoundSuccess } = await import("./apply-compound.js");
    mockGetOperatorCallerArn.mockResolvedValueOnce(undefined);
    const { log } = await import("@/utils/logger/index.js");

    const state = makeState({
      currentResourceIndex: 1,
      resourceType: "AWS::S3::Bucket",
      resourceArn: S3_BUCKET_NAME,
      resourceQueue: s3Queue as unknown as AgentState["resourceQueue"],
      resourcePattern: s3Pattern as unknown as AgentState["resourcePattern"],
      completedResources: [
        {
          resourceId: "cloudfront-dist",
          resourceType: "AWS::CloudFront::Distribution",
          resourceArn: "E1ABCDEF123456",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
    });

    await formatApplyCompoundSuccess(state);

    expect(mockAttachCompensatingBucketPolicy).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        extras: expect.objectContaining({
          compensatingBucketPolicySkipped: true,
        }),
      }),
    );
  });
});
