/**
 * Tests for ec2-routetable destroy strategy — non-main disassociate
 * with Main=true skip invariant.
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
  function DescribeRouteTablesCommand(i: Record<string, unknown>) {
    return { _type: "DescribeRouteTables", ...i };
  }
  function DisassociateRouteTableCommand(i: Record<string, unknown>) {
    return { _type: "DisassociateRouteTable", ...i };
  }
  return {
    EC2Client,
    DescribeRouteTablesCommand,
    DisassociateRouteTableCommand,
  };
});

import { ec2RouteTableStrategy } from "../ec2-routetable.js";
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
      arn: "arn:aws:ec2:us-east-1:123456789012:route-table/rtb-123",
      resourceType: "AWS::EC2::RouteTable",
      identifier: "rtb-123",
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

describe("ec2RouteTableStrategy", () => {
  it("disassociates non-main subnet associations, skipping Main=true", async () => {
    hoisted.mockEc2Send.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "DescribeRouteTables") {
        return {
          RouteTables: [
            {
              Associations: [
                {
                  RouteTableAssociationId: "assoc-main",
                  Main: true,
                  AssociationState: { State: "associated" },
                },
                {
                  RouteTableAssociationId: "assoc-subnet-1",
                  Main: false,
                  AssociationState: { State: "associated" },
                },
                {
                  RouteTableAssociationId: "assoc-subnet-2",
                  Main: false,
                  AssociationState: { State: "associated" },
                },
                {
                  // Already disassociated → skip
                  RouteTableAssociationId: "assoc-subnet-3",
                  Main: false,
                  AssociationState: { State: "disassociated" },
                },
              ],
            },
          ],
        };
      }
      if (cmd._type === "DisassociateRouteTable") return {};
      return {};
    });

    const outcome = await ec2RouteTableStrategy.preDestroy!(makeCtx());
    expect(outcome).toBeUndefined();
    const disassocCalls = hoisted.mockEc2Send.mock.calls.filter(
      (c) => c[0]._type === "DisassociateRouteTable",
    );
    expect(disassocCalls).toHaveLength(2);
    const ids = disassocCalls.map((c) => c[0].AssociationId).sort();
    expect(ids).toEqual(["assoc-subnet-1", "assoc-subnet-2"]);
  });

  it("is non-fatal on describe failure (logs + falls through)", async () => {
    hoisted.mockEc2Send.mockRejectedValue(new Error("ThrottlingException"));
    const outcome = await ec2RouteTableStrategy.preDestroy!(makeCtx());
    expect(outcome).toBeUndefined();
  });
});
