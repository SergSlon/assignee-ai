/**
 * graph-executor.ts — MCP mirror of the CLI orchestrator's envelope
 * projection (Epic 98 e98.W5.N1 / Epic 97 A-01 + B-01).
 *
 * The `shapeTerminalState` helper is not exported, so we exercise
 * `runApplyGraph` by stubbing `ctx.graph` to land on SUCCESS /
 * non-SUCCESS terminal states and assert the response envelope.
 *
 * Test-data discipline: account `210987654321`, realistic CCAPI
 * identifier shapes. No live AWS — `buildApplyEnvelopeArn` is
 * module-boundary-stubbed so the MCP-side projection test is
 * independent of the core helper's own coverage.
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

beforeEach(() => {
  vi.clearAllMocks();
});

function mkCtx(terminalState: Record<string, unknown>) {
  // Mimic the LangGraph contract: one invoke then getState reports
  // no next nodes (terminal). The executor enters the while-loop,
  // invokes, sees next.length === 0, breaks.
  const invoke = vi.fn().mockResolvedValue(terminalState);
  const getStateMock = vi.fn().mockResolvedValue({
    next: [],
    values: terminalState,
  });
  return {
    graph: {
      updateState: vi.fn().mockResolvedValue(undefined),
      invoke,
      getState: getStateMock,
    },
  } as never;
}

function mkRunArgs() {
  return {
    runId: "run-mcp-test",
    userIntent: "Create a resource",
    resourceType: "AWS::S3::Bucket",
    desiredState: {},
    preflightPassed: true,
  } as never;
}

async function invokeRunApplyGraph(terminalState: Record<string, unknown>) {
  const { runGraphFromCheckpoint } = await import("./graph-executor.js");
  return runGraphFromCheckpoint({
    ctx: mkCtx(terminalState),
    checkpoint: mkRunArgs(),
    preflightPassed: true,
  });
}

function parseEnvelope(envelope: unknown): Record<string, unknown> {
  const e = envelope as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return JSON.parse(e.content[0]!.text) as Record<string, unknown>;
}

describe("shapeTerminalState via runApplyGraph — ARN-addressable types", () => {
  it("Lambda compound terminal: resourceArn = full ARN, primaryIdentifier null (A-01 mirror)", async () => {
    mockBuildApplyEnvelopeArn.mockResolvedValueOnce({
      arn: "arn:aws:lambda:us-east-1:210987654321:function:dogfood-e97-a-fn-1776953643",
      primaryIdentifier: null,
    });
    const terminalState = {
      executionStatus: ExecutionStatus.SUCCESS,
      resourceType: "AWS::Lambda::Function",
      resourceArn: "dogfood-e97-a-fn-1776953643",
      estimatedMonthlyCost: "~$1.03/million req",
      securityFindings: [],
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

    const envelope = await invokeRunApplyGraph(terminalState);
    const parsed = parseEnvelope(envelope);

    expect(parsed["status"]).toBe("SUCCESS");
    expect(parsed["resourceArn"]).toBe(
      "arn:aws:lambda:us-east-1:210987654321:function:dogfood-e97-a-fn-1776953643",
    );
    expect(parsed["primaryIdentifier"]).toBeNull();
    expect(parsed["resourceType"]).toBe("AWS::Lambda::Function");
    expect(mockBuildApplyEnvelopeArn).toHaveBeenCalledWith(
      "AWS::Lambda::Function",
      "dogfood-e97-a-fn-1776953643",
    );
  });

  it("S3 single terminal: empty completedResources → finalState anchor", async () => {
    mockBuildApplyEnvelopeArn.mockResolvedValueOnce({
      arn: "arn:aws:s3:::dogfood-bucket-1776953600",
      primaryIdentifier: null,
    });
    const terminalState = {
      executionStatus: ExecutionStatus.SUCCESS,
      resourceType: "AWS::S3::Bucket",
      resourceArn: "dogfood-bucket-1776953600",
      estimatedMonthlyCost: "$0.023/GB-month",
      securityFindings: [],
      completedResources: [],
    };

    const envelope = await invokeRunApplyGraph(terminalState);
    const parsed = parseEnvelope(envelope);

    expect(parsed["resourceArn"]).toBe(
      "arn:aws:s3:::dogfood-bucket-1776953600",
    );
    expect(parsed["primaryIdentifier"]).toBeNull();
    expect(mockBuildApplyEnvelopeArn).toHaveBeenCalledWith(
      "AWS::S3::Bucket",
      "dogfood-bucket-1776953600",
    );
  });
});

describe("shapeTerminalState via runApplyGraph — non-taggable constructs (B-01 mirror)", () => {
  it("Route single terminal: resourceArn:null + primaryIdentifier rtb|cidr", async () => {
    mockBuildApplyEnvelopeArn.mockResolvedValueOnce({
      arn: null,
      primaryIdentifier: "rtb-016d13dcc6076462d|0.0.0.0/0",
    });
    const terminalState = {
      executionStatus: ExecutionStatus.SUCCESS,
      resourceType: "AWS::EC2::Route",
      resourceArn: "rtb-016d13dcc6076462d|0.0.0.0/0",
      estimatedMonthlyCost: "No charge",
      securityFindings: [],
      completedResources: [],
    };

    const envelope = await invokeRunApplyGraph(terminalState);
    const parsed = parseEnvelope(envelope);

    expect(parsed["resourceArn"]).toBeNull();
    expect(parsed["primaryIdentifier"]).toBe("rtb-016d13dcc6076462d|0.0.0.0/0");
  });

  it("VPCGatewayAttachment compound terminal: anchor is the last completed entry", async () => {
    mockBuildApplyEnvelopeArn.mockResolvedValueOnce({
      arn: null,
      primaryIdentifier: "igw-0abc12345|vpc-0def67890",
    });
    const terminalState = {
      executionStatus: ExecutionStatus.SUCCESS,
      resourceType: "AWS::EC2::VPCGatewayAttachment",
      resourceArn: "igw-0abc12345|vpc-0def67890",
      estimatedMonthlyCost: "Free",
      securityFindings: [],
      completedResources: [
        {
          resourceId: "igw",
          resourceType: "AWS::EC2::InternetGateway",
          resourceArn: "igw-0abc12345",
          executionStatus: ExecutionStatus.SUCCESS,
        },
        {
          resourceId: "attachment",
          resourceType: "AWS::EC2::VPCGatewayAttachment",
          resourceArn: "igw-0abc12345|vpc-0def67890",
          executionStatus: ExecutionStatus.SUCCESS,
        },
      ],
    };

    const envelope = await invokeRunApplyGraph(terminalState);
    const parsed = parseEnvelope(envelope);

    expect(mockBuildApplyEnvelopeArn).toHaveBeenCalledWith(
      "AWS::EC2::VPCGatewayAttachment",
      "igw-0abc12345|vpc-0def67890",
    );
    expect(parsed["resourceArn"]).toBeNull();
    expect(parsed["primaryIdentifier"]).toBe("igw-0abc12345|vpc-0def67890");
  });
});

describe("shapeTerminalState via runApplyGraph — failure path unchanged", () => {
  it("Non-SUCCESS status returns errorEnvelope (no projection call)", async () => {
    const terminalState = {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: "provisioning ended without success",
      resourceArn: "dogfood-fn",
      completedResources: [],
    };

    const envelope = await invokeRunApplyGraph(terminalState);
    const parsed = parseEnvelope(envelope);

    expect(parsed["error"]).toBe(true);
    expect(parsed["message"]).toContain("provisioning ended without success");
    // Non-SUCCESS does not invoke the projection — failures carry no
    // ARN/primaryIdentifier contract.
    expect(mockBuildApplyEnvelopeArn).not.toHaveBeenCalled();
  });
});
