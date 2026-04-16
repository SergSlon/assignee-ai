/**
 * Tests for ec2-internetgateway destroy strategy — normal detach and
 * half-state-safe per-attachment error handling (Wave 11 P2-3).
 *
 * @see Wave-6 F1b
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({ mockEc2Send: vi.fn() }));
vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = hoisted.mockEc2Send;
    destroy = vi.fn();
  }
  function DescribeInternetGatewaysCommand(i: Record<string, unknown>) {
    return { _type: "DescribeInternetGateways", ...i };
  }
  function DetachInternetGatewayCommand(i: Record<string, unknown>) {
    return { _type: "DetachInternetGateway", ...i };
  }
  return {
    EC2Client,
    DescribeInternetGatewaysCommand,
    DetachInternetGatewayCommand,
  };
});

import { ec2InternetGatewayStrategy } from "../ec2-internetgateway.js";
import type { DestroyContext } from "@assignee/core";

beforeEach(() => {
  vi.clearAllMocks();
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});

function makeCtx(): DestroyContext {
  return {
    resource: {
      arn: "arn:aws:ec2:us-east-1:123456789012:internet-gateway/igw-123",
      resourceType: "AWS::EC2::InternetGateway",
      identifier: "igw-123",
      region: "us-east-1",
    },
    awsConfig: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
    },
    effectiveRegion: "us-east-1",
    warn: () => {},
  };
}

describe("ec2InternetGatewayStrategy", () => {
  it("detaches every non-detached attachment", async () => {
    hoisted.mockEc2Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "DescribeInternetGateways") {
        return {
          InternetGateways: [
            {
              Attachments: [
                { VpcId: "vpc-1", State: "attached" },
                { VpcId: "vpc-2", State: "available" },
                { VpcId: "vpc-3", State: "detached" }, // skip
              ],
            },
          ],
        };
      }
      if (cmd._type === "DetachInternetGateway") return {};
      return {};
    });

    const outcome = await ec2InternetGatewayStrategy.preDestroy!(makeCtx());
    expect(outcome).toBeUndefined();
    const detachCalls = hoisted.mockEc2Send.mock.calls.filter(
      (c) => c[0]._type === "DetachInternetGateway",
    );
    expect(detachCalls).toHaveLength(2);
    expect(detachCalls.map((c) => c[0].VpcId).sort()).toEqual([
      "vpc-1",
      "vpc-2",
    ]);
  });

  it("continues the loop when one detach fails (half-state recovery)", async () => {
    hoisted.mockEc2Send.mockImplementation(
      (cmd: { _type: string; VpcId?: string }) => {
        if (cmd._type === "DescribeInternetGateways") {
          return {
            InternetGateways: [
              {
                Attachments: [
                  { VpcId: "vpc-ok-1", State: "attached" },
                  { VpcId: "vpc-bad", State: "attached" },
                  { VpcId: "vpc-ok-2", State: "attached" },
                ],
              },
            ],
          };
        }
        if (cmd._type === "DetachInternetGateway") {
          if (cmd.VpcId === "vpc-bad") {
            throw new Error("DependencyViolation");
          }
          return {};
        }
        return {};
      },
    );

    let warnCalled: { action: string; extras: Record<string, unknown> } | null =
      null;
    const ctx = {
      ...makeCtx(),
      warn: (a: string, e: Record<string, unknown>) => {
        warnCalled = { action: a, extras: e };
      },
    };
    const outcome = await ec2InternetGatewayStrategy.preDestroy!(ctx);
    expect(outcome).toBeUndefined();
    const detachCalls = hoisted.mockEc2Send.mock.calls.filter(
      (c) => c[0]._type === "DetachInternetGateway",
    );
    // All three attempted despite the middle one failing.
    expect(detachCalls).toHaveLength(3);
    // Strategy uses the module-level warnDestroy helper directly (not
    // ctx.warn), so we just assert that forward progress was preserved.
    void warnCalled;
  });
});
