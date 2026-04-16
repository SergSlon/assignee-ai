/**
 * Per-strategy failure-mode unit tests for igwStrategy.preDestroy.
 *
 * Covers behavior not exercised by credential-enforcement.test.ts:
 *  - AWS SDK throws DependencyViolation during DetachInternetGateway
 *  - DescribeInternetGateways returns no matching IGW
 *  - IGW has no Attachments at all (empty array, undefined)
 *  - Mixed attached/detached attachments (only attached ones are detached)
 *
 * Uses class-based SDK mocks (not vi.fn().mockImplementation) so they
 * survive vitest's mockReset:true between tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockEc2Send } = vi.hoisted(() => ({
  mockEc2Send: vi.fn(),
}));

vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = mockEc2Send;
    destroy = vi.fn();
  }
  function DescribeInternetGatewaysCommand(input: unknown) {
    return { _type: "DescribeInternetGateways", input };
  }
  function DetachInternetGatewayCommand(input: unknown) {
    return { _type: "DetachInternetGateway", input };
  }
  return {
    EC2Client,
    DescribeInternetGatewaysCommand,
    DetachInternetGatewayCommand,
  };
});

import { igwStrategy } from "../igw-strategy.js";
import { makeDestroyContext } from "./test-helpers.js";

const IGW_ID = "igw-0123456789abcdef0";
const VPC_ID_1 = "vpc-0aa1bb2cc3dd4ee5f";
const VPC_ID_2 = "vpc-0ff9ee8dd7cc6bb5a";
const REGION = "us-east-1";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("igwStrategy.preDestroy — failure modes", () => {
  it("propagates DependencyViolation when DetachInternetGateway fails", async () => {
    const dependencyErr = Object.assign(
      new Error(
        "Network vpc-0aa1bb2cc3dd4ee5f has some mapped public address(es). Please unmap those public address(es) before detaching the gateway.",
      ),
      { name: "DependencyViolation", $metadata: { httpStatusCode: 400 } },
    );

    mockEc2Send
      .mockResolvedValueOnce({
        InternetGateways: [
          {
            InternetGatewayId: IGW_ID,
            Attachments: [{ VpcId: VPC_ID_1, State: "attached" }],
          },
        ],
      })
      .mockRejectedValueOnce(dependencyErr);

    await expect(
      igwStrategy.preDestroy!(makeDestroyContext(IGW_ID, REGION)),
    ).rejects.toMatchObject({ name: "DependencyViolation" });

    // Describe + one attempted detach
    expect(mockEc2Send).toHaveBeenCalledTimes(2);
    const detachCmd = mockEc2Send.mock.calls[1]![0] as {
      _type: string;
      input: { InternetGatewayId: string; VpcId: string };
    };
    expect(detachCmd._type).toBe("DetachInternetGateway");
    expect(detachCmd.input.InternetGatewayId).toBe(IGW_ID);
    expect(detachCmd.input.VpcId).toBe(VPC_ID_1);
  });

  it("is a no-op when DescribeInternetGateways returns no matching IGW", async () => {
    mockEc2Send.mockResolvedValueOnce({ InternetGateways: [] });

    await expect(
      igwStrategy.preDestroy!(makeDestroyContext(IGW_ID, REGION)),
    ).resolves.toBeUndefined();

    // Only the describe call — no detach attempts
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
    const cmd = mockEc2Send.mock.calls[0]![0] as {
      _type: string;
      input: { InternetGatewayIds: string[] };
    };
    expect(cmd._type).toBe("DescribeInternetGateways");
    expect(cmd.input.InternetGatewayIds).toEqual([IGW_ID]);
  });

  it("is a no-op when the IGW has no attachments (empty array)", async () => {
    mockEc2Send.mockResolvedValueOnce({
      InternetGateways: [{ InternetGatewayId: IGW_ID, Attachments: [] }],
    });

    await expect(
      igwStrategy.preDestroy!(makeDestroyContext(IGW_ID, REGION)),
    ).resolves.toBeUndefined();
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the IGW's Attachments field is undefined", async () => {
    mockEc2Send.mockResolvedValueOnce({
      InternetGateways: [{ InternetGatewayId: IGW_ID }],
    });

    await expect(
      igwStrategy.preDestroy!(makeDestroyContext(IGW_ID, REGION)),
    ).resolves.toBeUndefined();
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });

  it("detaches attached VPCs while skipping already-detached ones in the same response", async () => {
    mockEc2Send
      .mockResolvedValueOnce({
        InternetGateways: [
          {
            InternetGatewayId: IGW_ID,
            Attachments: [
              { VpcId: VPC_ID_1, State: "detached" },
              { VpcId: VPC_ID_2, State: "attached" },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({});

    await igwStrategy.preDestroy!(makeDestroyContext(IGW_ID, REGION));

    // Describe + exactly one detach (for the attached VPC)
    expect(mockEc2Send).toHaveBeenCalledTimes(2);
    const detachCmd = mockEc2Send.mock.calls[1]![0] as {
      _type: string;
      input: { InternetGatewayId: string; VpcId: string };
    };
    expect(detachCmd._type).toBe("DetachInternetGateway");
    expect(detachCmd.input.VpcId).toBe(VPC_ID_2);
  });

  it("skips attachments without a VpcId", async () => {
    mockEc2Send.mockResolvedValueOnce({
      InternetGateways: [
        {
          InternetGatewayId: IGW_ID,
          Attachments: [{ State: "attached" }], // no VpcId
        },
      ],
    });

    await expect(
      igwStrategy.preDestroy!(makeDestroyContext(IGW_ID, REGION)),
    ).resolves.toBeUndefined();
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });
});
