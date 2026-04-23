/**
 * Orchestrator envelope-enrichment tests — Epic 98 e98.W5.N1 (Epic 97
 * A-01 + B-01): `runApply` returns an `ApplyRunResult` whose `arn` and
 * `primaryIdentifier` fields drive the `--json` envelope. These tests
 * pin the post-Phase-2 projection:
 *
 *   1. Lambda compound — the LAST completed resource wins; full ARN.
 *   2. Route apply — arn:null + primaryIdentifier rtb-XXX|cidr.
 *   3. SubnetRouteTableAssociation — arn:null + primaryIdentifier rtbassoc-XXX.
 *   4. VPCGatewayAttachment — arn:null + primaryIdentifier igw-XXX|vpc-YYY.
 *   5. S3 single — full ARN, primaryIdentifier null.
 *
 * We stub `buildApplyEnvelopeArn` at the module boundary so we assert
 * the orchestrator's anchor-picking logic without re-testing the core
 * helper (that's `envelope-arn.test.ts`). The stub records every call
 * so the suite also covers "resourceType + bareIdentifier are fed from
 * the RIGHT place" — a compound-vs-single regression we want to catch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionStatus, type ApplyEnvelopeArn } from "@assignee/core";

const mockBuildApplyEnvelopeArn = vi.hoisted(() =>
  vi.fn<
    (
      resourceType: string | undefined,
      identifier: string | undefined,
    ) => Promise<ApplyEnvelopeArn>
  >(),
);

vi.mock("@assignee/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@assignee/core")>();
  return {
    ...actual,
    buildApplyEnvelopeArn: (
      resourceType: string | undefined,
      identifier: string | undefined,
    ) => mockBuildApplyEnvelopeArn(resourceType, identifier),
  };
});

// Prevent the real Phase-1 planner and gate from running — we only
// want to exercise the post-Phase-2 enrichment path.
const mockRunPhase1 = vi.hoisted(() => vi.fn());
const mockHandlePhase1Outcome = vi.hoisted(() => vi.fn());
const mockRunProvisioningLoop = vi.hoisted(() => vi.fn());

vi.mock("./phase1-planner.js", () => ({
  runPhase1: (...args: unknown[]) => mockRunPhase1(...args),
}));
vi.mock("./phase1-gate.js", () => ({
  handlePhase1Outcome: (...args: unknown[]) => mockHandlePhase1Outcome(...args),
}));
vi.mock("../../utils/command-runner.js", () => ({
  runProvisioningLoop: (...args: unknown[]) => mockRunProvisioningLoop(...args),
}));
vi.mock("../../config/user-config-loader.js", () => ({
  loadUserConfig: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../config/load-global-config.js", () => ({
  loadGlobalConfig: vi.fn().mockResolvedValue({}),
}));
vi.mock("../../config/org-policy-cache.js", () => ({
  fetchOrgPolicy: vi.fn().mockResolvedValue(null),
  readAuthToken: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../utils/display.js", () => ({
  stopSpinner: vi.fn(),
}));
vi.mock("../../utils/logger.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    APPLY_COMPLETE: "apply_complete",
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Default: Phase-1 resolves; gate says "continue to phase 2".
  mockRunPhase1.mockResolvedValue({ executionStatus: ExecutionStatus.PENDING });
  mockHandlePhase1Outcome.mockResolvedValue({
    kind: "continue",
    phase1State: { executionStatus: ExecutionStatus.PENDING },
  });
});

function mkCtx() {
  return {
    runId: "run-orchestrator-test",
    startTs: 0,
    tools: [],
    graph: {} as never,
    intent: "Create a lambda",
  } as never;
}

function mkArgs() {
  return {
    opts: {} as never,
    intent: "Create a lambda",
    effectiveIntent: "Create a lambda",
    resolvedCheckpoint: null,
    resolvedSourceDir: undefined,
    sourceFileCount: undefined,
  } as never;
}

async function invokeRunApply(finalState: Record<string, unknown>) {
  mockRunProvisioningLoop.mockResolvedValue({ finalState, success: true });
  const { runApply } = await import("./orchestrator.js");
  return runApply(mkCtx(), mkArgs());
}

describe("runApply enrichResult — compound apply", () => {
  it("Lambda compound: anchors the envelope on the LAST completed resource (A-01)", async () => {
    mockBuildApplyEnvelopeArn.mockResolvedValueOnce({
      arn: "arn:aws:lambda:us-east-1:210987654321:function:dogfood-e97-a-fn-1776953643",
      primaryIdentifier: null,
    });
    const finalState = {
      runId: "run-42",
      resourceType: "AWS::Lambda::Function",
      resourceArn: "dogfood-e97-a-fn-1776953643",
      estimatedMonthlyCost: "~$1.03/million req",
      completedResources: [
        {
          resourceId: "lambda-execution-role",
          resourceType: "AWS::IAM::Role",
          resourceArn: "assignee-iam-execution-role-f483a7d2",
          executionStatus: ExecutionStatus.SUCCESS,
        },
        {
          resourceId: "lambda-fn",
          resourceType: "AWS::Lambda::Function",
          resourceArn: "dogfood-e97-a-fn-1776953643",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
    };

    const result = await invokeRunApply(finalState);

    expect(mockBuildApplyEnvelopeArn).toHaveBeenCalledWith(
      "AWS::Lambda::Function",
      "dogfood-e97-a-fn-1776953643",
    );
    expect(result.success).toBe(true);
    expect(result.arn).toBe(
      "arn:aws:lambda:us-east-1:210987654321:function:dogfood-e97-a-fn-1776953643",
    );
    expect(result.primaryIdentifier).toBeNull();
    expect(result.cost).toBe("~$1.03/million req");
  });

  it("Compound with non-taggable final entry: arn:null + primaryIdentifier", async () => {
    mockBuildApplyEnvelopeArn.mockResolvedValueOnce({
      arn: null,
      primaryIdentifier: "rtbassoc-0b2bb97aacd090704",
    });
    const finalState = {
      runId: "run-43",
      resourceType: "AWS::EC2::SubnetRouteTableAssociation",
      resourceArn: "rtbassoc-0b2bb97aacd090704",
      completedResources: [
        {
          resourceId: "rtb",
          resourceType: "AWS::EC2::RouteTable",
          resourceArn: "rtb-016d13dcc6076462d",
          executionStatus: ExecutionStatus.SUCCESS,
        },
        {
          resourceId: "srta",
          resourceType: "AWS::EC2::SubnetRouteTableAssociation",
          resourceArn: "rtbassoc-0b2bb97aacd090704",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
    };

    const result = await invokeRunApply(finalState);

    expect(mockBuildApplyEnvelopeArn).toHaveBeenCalledWith(
      "AWS::EC2::SubnetRouteTableAssociation",
      "rtbassoc-0b2bb97aacd090704",
    );
    expect(result.arn).toBeNull();
    expect(result.primaryIdentifier).toBe("rtbassoc-0b2bb97aacd090704");
  });
});

describe("runApply enrichResult — single-resource apply", () => {
  it("S3 single: falls back to finalState.resourceType + resourceArn (empty completedResources)", async () => {
    mockBuildApplyEnvelopeArn.mockResolvedValueOnce({
      arn: "arn:aws:s3:::dogfood-bucket-1776953600",
      primaryIdentifier: null,
    });
    const finalState = {
      runId: "run-44",
      resourceType: "AWS::S3::Bucket",
      resourceArn: "dogfood-bucket-1776953600",
      estimatedMonthlyCost: "$0.023/GB-month",
      completedResources: [],
    };

    const result = await invokeRunApply(finalState);

    expect(mockBuildApplyEnvelopeArn).toHaveBeenCalledWith(
      "AWS::S3::Bucket",
      "dogfood-bucket-1776953600",
    );
    expect(result.arn).toBe("arn:aws:s3:::dogfood-bucket-1776953600");
    expect(result.primaryIdentifier).toBeNull();
  });

  it("Route single apply: non-taggable → arn:null + primaryIdentifier rtb|cidr (B-01)", async () => {
    mockBuildApplyEnvelopeArn.mockResolvedValueOnce({
      arn: null,
      primaryIdentifier: "rtb-016d13dcc6076462d|0.0.0.0/0",
    });
    const finalState = {
      runId: "run-45",
      resourceType: "AWS::EC2::Route",
      resourceArn: "rtb-016d13dcc6076462d|0.0.0.0/0",
      completedResources: undefined,
    };

    const result = await invokeRunApply(finalState);

    expect(mockBuildApplyEnvelopeArn).toHaveBeenCalledWith(
      "AWS::EC2::Route",
      "rtb-016d13dcc6076462d|0.0.0.0/0",
    );
    expect(result.arn).toBeNull();
    expect(result.primaryIdentifier).toBe("rtb-016d13dcc6076462d|0.0.0.0/0");
  });

  it("VPCGatewayAttachment single apply: arn:null + primaryIdentifier igw|vpc", async () => {
    mockBuildApplyEnvelopeArn.mockResolvedValueOnce({
      arn: null,
      primaryIdentifier: "igw-0abc12345|vpc-0def67890",
    });
    const finalState = {
      runId: "run-46",
      resourceType: "AWS::EC2::VPCGatewayAttachment",
      resourceArn: "igw-0abc12345|vpc-0def67890",
      completedResources: [],
    };

    const result = await invokeRunApply(finalState);

    expect(mockBuildApplyEnvelopeArn).toHaveBeenCalledWith(
      "AWS::EC2::VPCGatewayAttachment",
      "igw-0abc12345|vpc-0def67890",
    );
    expect(result.arn).toBeNull();
    expect(result.primaryIdentifier).toBe("igw-0abc12345|vpc-0def67890");
  });
});

describe("runApply enrichResult — defensive edge cases", () => {
  it("skips completedResources anchor when last entry has empty resourceArn", async () => {
    // Defensive: if the LAST entry's resourceArn is somehow empty
    // (graph bug), fall back to finalState's top-level resourceArn so
    // the envelope doesn't drop the fix entirely.
    mockBuildApplyEnvelopeArn.mockResolvedValueOnce({
      arn: "arn:aws:s3:::fallback-bucket",
      primaryIdentifier: null,
    });
    const finalState = {
      runId: "run-47",
      resourceType: "AWS::S3::Bucket",
      resourceArn: "fallback-bucket",
      completedResources: [
        {
          resourceId: "anchor-with-no-arn",
          resourceType: "AWS::EC2::VPC",
          resourceArn: "", // degenerate
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
    };

    const result = await invokeRunApply(finalState);

    expect(mockBuildApplyEnvelopeArn).toHaveBeenCalledWith(
      "AWS::S3::Bucket",
      "fallback-bucket",
    );
    expect(result.arn).toBe("arn:aws:s3:::fallback-bucket");
  });

  it("surfaces runId from fallback when finalState.runId is absent", async () => {
    mockBuildApplyEnvelopeArn.mockResolvedValueOnce({
      arn: null,
      primaryIdentifier: null,
    });
    const finalState = {
      resourceType: "AWS::S3::Bucket",
      resourceArn: undefined,
      completedResources: [],
    };

    const result = await invokeRunApply(finalState);
    expect(result.runId).toBe("run-orchestrator-test");
  });
});
