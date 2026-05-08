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
  // M1 fix: production reality — `buildDisplayArnMap` always
  // populates a `resourceId → fullArn` map (see
  // `result-formatter/arn-templates.ts`). The previous empty-map
  // default masked H1 (bare-vs-full-ARN mismatch) by routing the
  // arnForRecord fallback to `completed.resourceArn` (BARE form).
  // With the H1 fix the policy-outcome lookup is keyed by
  // `resourceId` so the ARN form no longer matters for that
  // lookup, but the default must reflect production: full ARNs
  // in the map. Realistic AWS ARN shapes per
  // `feedback_real_data_mocks_all_cases`. Individual tests can
  // re-stub via `mockResolvedValueOnce` when they need a
  // narrower fixture.
  _arnDisplayMocks.buildDisplayArnMap.mockResolvedValue({
    "vpc-main": "arn:aws:ec2:us-east-1:210987654321:vpc/vpc-abcdef01",
    "subnet-public":
      "arn:aws:ec2:us-east-1:210987654321:subnet/subnet-99887766",
    "cloudfront-dist":
      "arn:aws:cloudfront::210987654321:distribution/E1ABCDEF123456",
    "s3-bucket": "arn:aws:s3:::assignee-static-site-2026",
    "s3-a": "arn:aws:s3:::assignee-bucket-a-2026",
    "s3-b": "arn:aws:s3:::assignee-bucket-b-2026",
    "s3-c": "arn:aws:s3:::assignee-bucket-c-2026",
  });
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
    const { writeProvisionRecord } = await import("@/utils/memory-recorder.js");
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

    // H1 fix verification: provision record for the S3 bucket must
    // carry compensatingPolicyAttached=false + the reason — proves
    // the resourceId-keyed lookup correctly surfaces the failure on
    // the matching record even though the writer derives a FULL
    // ARN via displayArns while the policy-outcome map keys by
    // resourceId.
    const writeCalls = (
      writeProvisionRecord as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    const s3Call = writeCalls.find((c) => c[1] === "AWS::S3::Bucket");
    expect(s3Call).toBeDefined();
    expect(s3Call![6]).toEqual({
      compensatingPolicyAttached: false,
      compensatingPolicyError: "ThrottlingException",
    });

    stderrSpy.mockRestore();
  });

  // bug-s3-bucket-policy-compound-serialization: replace the previous
  // sequential `for…await` with a bounded-concurrency runner. Today no
  // pattern provisions multiple S3 buckets so the observable difference
  // is zero, but the structure must (a) attempt EVERY bucket even when
  // earlier ones fail (no early-exit on rejection) and (b) preserve
  // per-bucket outcomes so the provision-record writer can flag the
  // failed buckets to `assignee list`.
  describe("bounded-concurrency S3 PutBucketPolicy in compound terminal SUCCESS", () => {
    const BUCKET_A = "assignee-bucket-a-2026";
    const BUCKET_B = "assignee-bucket-b-2026";
    const BUCKET_C = "assignee-bucket-c-2026";

    const tripleS3Queue = [
      {
        resourceId: "s3-a",
        resourceType: "AWS::S3::Bucket",
        displayName: "Bucket A",
      },
      {
        resourceId: "s3-b",
        resourceType: "AWS::S3::Bucket",
        displayName: "Bucket B",
      },
      {
        resourceId: "s3-c",
        resourceType: "AWS::S3::Bucket",
        displayName: "Bucket C",
      },
    ];

    const tripleS3Pattern = {
      patternId: "triple-s3",
      displayName: "Triple S3",
      keywords: ["s3"],
      resourceList: tripleS3Queue,
      dependencyOrder: [["s3-a"], ["s3-b"], ["s3-c"]],
      defaultOptions: {},
    };

    it("attempts every bucket even when one fails, and preserves per-bucket outcomes", async () => {
      const { formatApplyCompoundSuccess } =
        await import("./apply-compound.js");
      const { writeProvisionRecord } =
        await import("@/utils/memory-recorder.js");
      mockGetOperatorCallerArn.mockResolvedValue(OPERATOR_ARN);
      // M1 fix: stub buildDisplayArnMap to return realistic FULL
      // ARNs keyed by resourceId — this is what production
      // resolution always returns (see arn-templates.ts). The
      // previous default `{}` masked H1 by routing arnForRecord
      // back to the BARE name; the new default + H1 fix
      // (resourceId-keyed lookup) means the per-bucket outcome is
      // now correctly threaded onto the matching provision record.
      _arnDisplayMocks.buildDisplayArnMap.mockResolvedValueOnce({
        "s3-a": `arn:aws:s3:::${BUCKET_A}`,
        "s3-b": `arn:aws:s3:::${BUCKET_B}`,
        "s3-c": `arn:aws:s3:::${BUCKET_C}`,
      });
      // Bucket B fails; A and C succeed. Match by bucketName so the
      // ordering is independent of the concurrency runner.
      mockAttachCompensatingBucketPolicy.mockImplementation(
        async (args: { bucketName: string }) => {
          if (args.bucketName === BUCKET_B) {
            return {
              attached: false,
              reason: "AccessDenied: PutBucketPolicy not allowed",
            };
          }
          return { attached: true };
        },
      );

      const state = makeState({
        currentResourceIndex: 2,
        resourceType: "AWS::S3::Bucket",
        resourceArn: BUCKET_C,
        resourceQueue: tripleS3Queue as unknown as AgentState["resourceQueue"],
        resourcePattern:
          tripleS3Pattern as unknown as AgentState["resourcePattern"],
        completedResources: [
          {
            resourceId: "s3-a",
            resourceType: "AWS::S3::Bucket",
            resourceArn: BUCKET_A,
            executionStatus: ExecutionStatus.SUCCESS,
          },
          {
            resourceId: "s3-b",
            resourceType: "AWS::S3::Bucket",
            resourceArn: BUCKET_B,
            executionStatus: ExecutionStatus.SUCCESS,
          },
        ],
      });

      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);

      await formatApplyCompoundSuccess(state);

      // All 3 buckets must be attempted — no early-exit on the failure.
      expect(mockAttachCompensatingBucketPolicy).toHaveBeenCalledTimes(3);
      const attemptedNames = mockAttachCompensatingBucketPolicy.mock.calls.map(
        (call: unknown[]) => (call[0] as { bucketName: string }).bucketName,
      );
      expect(attemptedNames).toEqual(
        expect.arrayContaining([BUCKET_A, BUCKET_B, BUCKET_C]),
      );

      // The failure for Bucket B surfaces a stderr warning citing the
      // bucket name and reason — proves per-bucket outcomes are
      // preserved, not collapsed into a single failure.
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(stderrText).toContain(BUCKET_B);
      expect(stderrText).toContain("AccessDenied");
      // Successful buckets must NOT appear in the warning output.
      expect(stderrText).not.toContain(`could not be attached to ${BUCKET_A}`);
      expect(stderrText).not.toContain(`could not be attached to ${BUCKET_C}`);

      // H1 fix verification: writeProvisionRecord must be called for
      // every completed S3 bucket with extras matching the per-bucket
      // attach outcome. Previously, the BARE-vs-FULL-ARN map mismatch
      // silently dropped the extras for compound applies.
      const writeCalls = (
        writeProvisionRecord as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls;
      const callByArn = new Map<string, unknown[]>();
      for (const c of writeCalls) {
        const arn = c[2] as string;
        callByArn.set(arn, c);
      }
      // BUCKET_B failed → extras should carry attached=false + reason.
      const callB = callByArn.get(`arn:aws:s3:::${BUCKET_B}`);
      expect(callB).toBeDefined();
      expect(callB![6]).toEqual({
        compensatingPolicyAttached: false,
        compensatingPolicyError: "AccessDenied: PutBucketPolicy not allowed",
      });
      // BUCKET_A succeeded → attached=true, no error field.
      const callA = callByArn.get(`arn:aws:s3:::${BUCKET_A}`);
      expect(callA).toBeDefined();
      expect(callA![6]).toEqual({ compensatingPolicyAttached: true });
      // BUCKET_C succeeded → attached=true, no error field.
      const callC = callByArn.get(`arn:aws:s3:::${BUCKET_C}`);
      expect(callC).toBeDefined();
      expect(callC![6]).toEqual({ compensatingPolicyAttached: true });

      stderrSpy.mockRestore();
    });

    it("runWithBoundedConcurrency caps in-flight tasks and runs every item even on per-task throws", async () => {
      const { runWithBoundedConcurrency } = await import("./apply-compound.js");

      let inFlight = 0;
      let maxInFlight = 0;
      const completed: number[] = [];
      const items = [0, 1, 2, 3, 4, 5, 6, 7];

      await runWithBoundedConcurrency(3, items, async (i) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        // Item 4 throws — runner must swallow and continue.
        if (i === 4) {
          inFlight--;
          throw new Error("simulated SDK failure");
        }
        completed.push(i);
        inFlight--;
      });

      // Concurrency cap respected.
      expect(maxInFlight).toBeLessThanOrEqual(3);
      // Every non-throwing item completed (the throw didn't abort the batch).
      expect(completed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 5, 6, 7]);
    });

    it("runWithBoundedConcurrency is a no-op for empty input", async () => {
      const { runWithBoundedConcurrency } = await import("./apply-compound.js");
      const task = vi.fn();
      await runWithBoundedConcurrency(5, [], task);
      expect(task).not.toHaveBeenCalled();
    });
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
