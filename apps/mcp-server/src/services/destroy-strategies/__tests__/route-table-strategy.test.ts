/**
 * Per-strategy failure-mode unit tests for routeTableStrategy.preDestroy.
 *
 * Covers:
 *  - DescribeRouteTables returns no matching table
 *  - Table has no associations
 *  - Table has only the Main=true association (skipped)
 *  - Mixed Main + non-Main associations (only non-Main are disassociated)
 *  - DisassociateRouteTable propagates SDK errors
 *  - Already-disassociated entries are skipped
 *  - Associations without a RouteTableAssociationId are skipped
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
  }
  function DescribeRouteTablesCommand(input: unknown) {
    return { _type: "DescribeRouteTables", input };
  }
  function DisassociateRouteTableCommand(input: unknown) {
    return { _type: "DisassociateRouteTable", input };
  }
  return {
    EC2Client,
    DescribeRouteTablesCommand,
    DisassociateRouteTableCommand,
  };
});

import { routeTableStrategy } from "../route-table-strategy.js";

const RT_ID = "rtb-0123456789abcdef0";
const ASSOC_ID_1 = "rtbassoc-0aa1bb2cc3dd4ee5f";
const ASSOC_ID_2 = "rtbassoc-0ff9ee8dd7cc6bb5a";
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

describe("routeTableStrategy.preDestroy — failure modes", () => {
  it("propagates SDK errors when DisassociateRouteTable fails", async () => {
    const dependencyErr = Object.assign(
      new Error("The route table association is in use and cannot be removed."),
      { name: "DependencyViolation", $metadata: { httpStatusCode: 400 } },
    );

    mockEc2Send
      .mockResolvedValueOnce({
        RouteTables: [
          {
            RouteTableId: RT_ID,
            Associations: [
              {
                RouteTableAssociationId: ASSOC_ID_1,
                Main: false,
                AssociationState: { State: "associated" },
              },
            ],
          },
        ],
      })
      .mockRejectedValueOnce(dependencyErr);

    await expect(
      routeTableStrategy.preDestroy!(RT_ID, REGION),
    ).rejects.toMatchObject({ name: "DependencyViolation" });

    expect(mockEc2Send).toHaveBeenCalledTimes(2);
    const disassocCmd = mockEc2Send.mock.calls[1]![0] as {
      _type: string;
      input: { AssociationId: string };
    };
    expect(disassocCmd._type).toBe("DisassociateRouteTable");
    expect(disassocCmd.input.AssociationId).toBe(ASSOC_ID_1);
  });

  it("is a no-op when DescribeRouteTables returns no matching table", async () => {
    mockEc2Send.mockResolvedValueOnce({ RouteTables: [] });

    await expect(
      routeTableStrategy.preDestroy!(RT_ID, REGION),
    ).resolves.toBeUndefined();

    expect(mockEc2Send).toHaveBeenCalledTimes(1);
    const cmd = mockEc2Send.mock.calls[0]![0] as {
      _type: string;
      input: { RouteTableIds: string[] };
    };
    expect(cmd._type).toBe("DescribeRouteTables");
    expect(cmd.input.RouteTableIds).toEqual([RT_ID]);
  });

  it("is a no-op when the route table has no associations", async () => {
    mockEc2Send.mockResolvedValueOnce({
      RouteTables: [{ RouteTableId: RT_ID, Associations: [] }],
    });

    await expect(
      routeTableStrategy.preDestroy!(RT_ID, REGION),
    ).resolves.toBeUndefined();
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });

  it("skips Main=true associations (cannot be disassociated from VPC main RT)", async () => {
    mockEc2Send.mockResolvedValueOnce({
      RouteTables: [
        {
          RouteTableId: RT_ID,
          Associations: [
            {
              RouteTableAssociationId: ASSOC_ID_1,
              Main: true,
              AssociationState: { State: "associated" },
            },
          ],
        },
      ],
    });

    await expect(
      routeTableStrategy.preDestroy!(RT_ID, REGION),
    ).resolves.toBeUndefined();
    // Only describe — no disassociate attempts on the main association
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });

  it("disassociates non-Main while skipping Main in the same response", async () => {
    mockEc2Send
      .mockResolvedValueOnce({
        RouteTables: [
          {
            RouteTableId: RT_ID,
            Associations: [
              {
                RouteTableAssociationId: ASSOC_ID_1,
                Main: true,
                AssociationState: { State: "associated" },
              },
              {
                RouteTableAssociationId: ASSOC_ID_2,
                Main: false,
                AssociationState: { State: "associated" },
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({});

    await routeTableStrategy.preDestroy!(RT_ID, REGION);

    // Describe + exactly one disassociate (the non-Main one)
    expect(mockEc2Send).toHaveBeenCalledTimes(2);
    const disassocCmd = mockEc2Send.mock.calls[1]![0] as {
      _type: string;
      input: { AssociationId: string };
    };
    expect(disassocCmd._type).toBe("DisassociateRouteTable");
    expect(disassocCmd.input.AssociationId).toBe(ASSOC_ID_2);
  });

  it("skips already-disassociated entries", async () => {
    mockEc2Send.mockResolvedValueOnce({
      RouteTables: [
        {
          RouteTableId: RT_ID,
          Associations: [
            {
              RouteTableAssociationId: ASSOC_ID_1,
              Main: false,
              AssociationState: { State: "disassociated" },
            },
          ],
        },
      ],
    });

    await expect(
      routeTableStrategy.preDestroy!(RT_ID, REGION),
    ).resolves.toBeUndefined();
    // Only describe — disassociated entries are skipped
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });

  it("skips associations without a RouteTableAssociationId", async () => {
    mockEc2Send.mockResolvedValueOnce({
      RouteTables: [
        {
          RouteTableId: RT_ID,
          Associations: [
            { Main: false, AssociationState: { State: "associated" } },
          ],
        },
      ],
    });

    await expect(
      routeTableStrategy.preDestroy!(RT_ID, REGION),
    ).resolves.toBeUndefined();
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });
});
