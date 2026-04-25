/**
 * Unit tests for the EC2 Internet Gateway destroy strategy.
 *
 * Covers (feedback_destroy_predelete_hooks_for_cfn_only_constructs):
 *   1. Happy path — no attachments; preDestroy is a no-op
 *   2. Happy path — one attached VPC detached successfully
 *   3. Happy path — already-detached VPC skipped (State==="detached")
 *   4. Edge case — partial detach failure: some succeed, some fail → warn igw_partial_detach_state
 *   5. Edge case — MissingAssigneeCredentialsError → hard failure
 *   6. Edge case — DescribeInternetGateways throws non-credential error → non-fatal warn
 *   7. Edge case — IGW not found in response (empty array) → no-op
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ec2InternetGatewayStrategy } from "./ec2-internetgateway.js";
import type { DestroyContext } from "../types.js";
import { RESOURCE_TYPES } from "../../config/resource-types/named.js";
import { MissingAssigneeCredentialsError } from "../../config/aws-credentials.js";

// ── Hoisted mocks ─────────────────────────────────────────────────────

const { mockEc2Send, mockEc2Destroy, mockRequireAssigneeCredentials } =
  vi.hoisted(() => ({
    mockEc2Send: vi.fn(),
    mockEc2Destroy: vi.fn(),
    mockRequireAssigneeCredentials: vi.fn(),
  }));

vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = mockEc2Send;
    destroy = mockEc2Destroy;
  }
  function DescribeInternetGatewaysCommand(input: unknown) {
    return { _type: "DescribeInternetGatewaysCommand", input };
  }
  function DetachInternetGatewayCommand(input: unknown) {
    return { _type: "DetachInternetGatewayCommand", input };
  }
  return {
    EC2Client,
    DescribeInternetGatewaysCommand,
    DetachInternetGatewayCommand,
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

const IGW_ID = "igw-0abc123456789def0";
const IGW_ARN = `arn:aws:ec2:us-east-1:210987654321:internet-gateway/${IGW_ID}`;

function makeCtx(overrides: Partial<DestroyContext> = {}): DestroyContext {
  return {
    resource: {
      arn: IGW_ARN,
      resourceType: RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
      identifier: IGW_ID,
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

beforeEach(() => {
  mockEc2Send.mockReset();
  mockEc2Destroy.mockReset();
  mockRequireAssigneeCredentials.mockReturnValue({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 1. Happy path — no attachments ───────────────────────────────────

describe("ec2InternetGatewayStrategy.preDestroy — no attachments", () => {
  it("calls Describe and returns void without any Detach calls", async () => {
    mockEc2Send.mockResolvedValueOnce({
      InternetGateways: [{ InternetGatewayId: IGW_ID, Attachments: [] }],
    });

    const ctx = makeCtx();
    const result = await ec2InternetGatewayStrategy.preDestroy!(ctx);

    expect(result).toBeUndefined();
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
    expect(ctx.warn).not.toHaveBeenCalled();
    expect(mockEc2Destroy).toHaveBeenCalledTimes(1);
  });
});

// ── 2. Happy path — one attached VPC ─────────────────────────────────

describe("ec2InternetGatewayStrategy.preDestroy — one attached VPC", () => {
  it("issues one DetachInternetGateway call for the attached VPC", async () => {
    const VPC_ID = "vpc-0123456789abcdef0";
    mockEc2Send
      .mockResolvedValueOnce({
        InternetGateways: [
          { Attachments: [{ VpcId: VPC_ID, State: "available" }] },
        ],
      })
      .mockResolvedValueOnce({}); // DetachInternetGatewayCommand

    const ctx = makeCtx();
    await ec2InternetGatewayStrategy.preDestroy!(ctx);

    expect(mockEc2Send).toHaveBeenCalledTimes(2);
    expect(mockEc2Send.mock.calls[1]![0]).toMatchObject({
      _type: "DetachInternetGatewayCommand",
      input: { InternetGatewayId: IGW_ID, VpcId: VPC_ID },
    });
    expect(ctx.warn).not.toHaveBeenCalled();
  });
});

// ── 3. Already-detached attachment skipped ─────────────────────────────

describe("ec2InternetGatewayStrategy.preDestroy — already detached", () => {
  it("skips attachments with State===detached without calling Detach", async () => {
    mockEc2Send.mockResolvedValueOnce({
      InternetGateways: [
        { Attachments: [{ VpcId: "vpc-111", State: "detached" }] },
      ],
    });

    const ctx = makeCtx();
    await ec2InternetGatewayStrategy.preDestroy!(ctx);

    // Only the Describe call — no Detach.
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });
});

// ── 4. Partial detach failure → warn igw_partial_detach_state ────────

describe("ec2InternetGatewayStrategy.preDestroy — partial detach failure", () => {
  it("emits igw_partial_detach_state warn when some VPCs fail to detach", async () => {
    const VPC_GOOD = "vpc-good-00000000000";
    const VPC_BAD = "vpc-bad-111111111111";

    mockEc2Send
      .mockResolvedValueOnce({
        InternetGateways: [
          {
            Attachments: [
              { VpcId: VPC_GOOD, State: "available" },
              { VpcId: VPC_BAD, State: "available" },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({}) // VPC_GOOD detach succeeds
      .mockRejectedValueOnce(
        new Error("DependencyViolation: still has resources"),
      ); // VPC_BAD fails

    const ctx = makeCtx();
    await ec2InternetGatewayStrategy.preDestroy!(ctx);

    expect(ctx.warn).toHaveBeenCalledWith(
      "igw_partial_detach_state",
      expect.objectContaining({
        identifier: IGW_ID,
        detachedCount: 1,
        remainingCount: 1,
      }),
    );
  });
});

// ── 5. MissingAssigneeCredentialsError → hard failure ─────────────────

describe("ec2InternetGatewayStrategy.preDestroy — missing credentials", () => {
  it("returns hard failure when operator credentials are absent", async () => {
    mockRequireAssigneeCredentials.mockImplementation(() => {
      throw new MissingAssigneeCredentialsError(
        "operator",
        "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
        "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
      );
    });

    const ctx = makeCtx();
    const outcome = await ec2InternetGatewayStrategy.preDestroy!(ctx);

    expect(outcome?.success).toBe(false);
    expect(outcome?.error).toContain("Cannot detach InternetGateway");
  });
});

// ── 6. Non-credential DescribeInternetGateways error → non-fatal ───────

describe("ec2InternetGatewayStrategy.preDestroy — describe fails non-fatally", () => {
  it("warns igw_detach_failed and returns undefined when Describe throws", async () => {
    mockEc2Send.mockRejectedValueOnce(new Error("RequestExpired: clock skew"));

    const ctx = makeCtx();
    const result = await ec2InternetGatewayStrategy.preDestroy!(ctx);

    expect(result).toBeUndefined();
    expect(ctx.warn).toHaveBeenCalledWith(
      "igw_detach_failed",
      expect.objectContaining({ identifier: IGW_ID }),
    );
  });
});

// ── 7. IGW not found in Describe response ────────────────────────────

describe("ec2InternetGatewayStrategy.preDestroy — empty describe response", () => {
  it("handles missing InternetGateways array gracefully (no-op)", async () => {
    mockEc2Send.mockResolvedValueOnce({ InternetGateways: [] });

    const ctx = makeCtx();
    const result = await ec2InternetGatewayStrategy.preDestroy!(ctx);

    expect(result).toBeUndefined();
    expect(ctx.warn).not.toHaveBeenCalled();
  });
});

// ── Strategy metadata ─────────────────────────────────────────────────

describe("ec2InternetGatewayStrategy metadata", () => {
  it("has the correct resourceType", () => {
    expect(ec2InternetGatewayStrategy.resourceType).toBe(
      RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
    );
  });

  it("exposes a preDestroy hook only", () => {
    expect(typeof ec2InternetGatewayStrategy.preDestroy).toBe("function");
    expect(ec2InternetGatewayStrategy.destroy).toBeUndefined();
    expect(ec2InternetGatewayStrategy.postDestroy).toBeUndefined();
  });
});
