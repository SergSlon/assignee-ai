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
    destroy = vi.fn();
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

import { ec2RouteTableStrategy as routeTableStrategy } from "@assignee/core";
import { makeDestroyContext } from "./test-helpers.js";

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
  // Wave 11 P2-4: changed from "propagate SDK errors" (the previous
  // throw-on-failure contract) to "warn-and-continue" — match the CLI
  // hook in apps/cli/src/services/destroy-service.ts so MCP and CLI
  // produce the same outcome for the same conditions. Per-association
  // disassociation failures are logged to stderr and the loop
  // continues; CCAPI's subsequent DeleteResource produces the
  // authoritative error if the residual association actually blocks.
  it("warns and continues when DisassociateRouteTable fails for one association (does not throw)", async () => {
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

    // The new contract: resolves (not rejects) — error swallowed and
    // logged to stderr. Pre-Wave-11 the test asserted .rejects with
    // matchObject; that contract is gone.
    await expect(
      routeTableStrategy.preDestroy!(makeDestroyContext(RT_ID, REGION)),
    ).resolves.toBeUndefined();

    expect(mockEc2Send).toHaveBeenCalledTimes(2);
    const disassocCmd = mockEc2Send.mock.calls[1]![0] as {
      _type: string;
      input: { AssociationId: string };
    };
    expect(disassocCmd._type).toBe("DisassociateRouteTable");
    expect(disassocCmd.input.AssociationId).toBe(ASSOC_ID_1);
  });

  // Wave 11 P2-4: companion test — when ONE association fails but
  // OTHERS exist in the same RouteTable, the loop continues and the
  // remaining associations are still attempted. Mirrors the IGW
  // half-state recovery in P2-3.
  it("continues to remaining associations after a per-association failure", async () => {
    const ASSOC_2 = "rtbassoc-second";
    const ASSOC_3 = "rtbassoc-third";

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
              {
                RouteTableAssociationId: ASSOC_2,
                Main: false,
                AssociationState: { State: "associated" },
              },
              {
                RouteTableAssociationId: ASSOC_3,
                Main: false,
                AssociationState: { State: "associated" },
              },
            ],
          },
        ],
      })
      // First disassoc OK
      .mockResolvedValueOnce({})
      // Second disassoc fails
      .mockRejectedValueOnce(
        Object.assign(new Error("transient error"), {
          name: "RequestLimitExceeded",
        }),
      )
      // Third disassoc must STILL be attempted under the new behavior
      .mockResolvedValueOnce({});

    await expect(
      routeTableStrategy.preDestroy!(makeDestroyContext(RT_ID, REGION)),
    ).resolves.toBeUndefined();

    // 1 describe + 3 disassoc = 4 calls
    expect(mockEc2Send).toHaveBeenCalledTimes(4);
    const disassocCalls = mockEc2Send.mock.calls
      .slice(1)
      .map(
        (c) =>
          (c[0] as { input: { AssociationId: string } }).input.AssociationId,
      );
    expect(disassocCalls).toEqual([ASSOC_ID_1, ASSOC_2, ASSOC_3]);
  });

  // Wave 11 P2-4: DescribeRouteTables failure also warns and continues
  // (the original would have thrown). Match the CLI hook's "let CCAPI
  // surface authoritative errors" philosophy.
  it("warns and continues when DescribeRouteTables fails entirely", async () => {
    mockEc2Send.mockRejectedValueOnce(
      Object.assign(new Error("rate exceeded"), {
        name: "RequestLimitExceeded",
      }),
    );

    await expect(
      routeTableStrategy.preDestroy!(makeDestroyContext(RT_ID, REGION)),
    ).resolves.toBeUndefined();

    // Only the describe was attempted
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when DescribeRouteTables returns no matching table", async () => {
    mockEc2Send.mockResolvedValueOnce({ RouteTables: [] });

    await expect(
      routeTableStrategy.preDestroy!(makeDestroyContext(RT_ID, REGION)),
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
      routeTableStrategy.preDestroy!(makeDestroyContext(RT_ID, REGION)),
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
      routeTableStrategy.preDestroy!(makeDestroyContext(RT_ID, REGION)),
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

    await routeTableStrategy.preDestroy!(makeDestroyContext(RT_ID, REGION));

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
      routeTableStrategy.preDestroy!(makeDestroyContext(RT_ID, REGION)),
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
      routeTableStrategy.preDestroy!(makeDestroyContext(RT_ID, REGION)),
    ).resolves.toBeUndefined();
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });
});
