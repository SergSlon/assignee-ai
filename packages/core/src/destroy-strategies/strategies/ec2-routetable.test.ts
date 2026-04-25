/**
 * Unit tests for the EC2 RouteTable destroy strategy.
 *
 * Covers (feedback_destroy_predelete_hooks_for_cfn_only_constructs):
 *   1. Happy path — no associations; preDestroy is a no-op
 *   2. Happy path — one non-main subnet association disassociated
 *   3. Happy path — main association skipped (Main=true)
 *   4. Happy path — already-disassociated association skipped
 *   5. Edge case — one disassociate fails (non-fatal per-assoc warn)
 *   6. Edge case — DescribeRouteTables throws → warns route_table_describe_failed and returns
 *   7. Edge case — MissingAssigneeCredentialsError → hard failure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ec2RouteTableStrategy } from "./ec2-routetable.js";
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
  function DescribeRouteTablesCommand(input: unknown) {
    return { _type: "DescribeRouteTablesCommand", input };
  }
  function DisassociateRouteTableCommand(input: unknown) {
    return { _type: "DisassociateRouteTableCommand", input };
  }
  return {
    EC2Client,
    DescribeRouteTablesCommand,
    DisassociateRouteTableCommand,
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

const RT_ID = "rtb-0abc123456789def0";
const RT_ARN = `arn:aws:ec2:us-east-1:210987654321:route-table/${RT_ID}`;

function makeCtx(overrides: Partial<DestroyContext> = {}): DestroyContext {
  return {
    resource: {
      arn: RT_ARN,
      resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
      identifier: RT_ID,
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

// ── 1. Happy path — no associations ───────────────────────────────────

describe("ec2RouteTableStrategy.preDestroy — no associations", () => {
  it("calls DescribeRouteTables and returns void (no Disassociate calls)", async () => {
    mockEc2Send.mockResolvedValueOnce({
      RouteTables: [{ RouteTableId: RT_ID, Associations: [] }],
    });

    const ctx = makeCtx();
    const result = await ec2RouteTableStrategy.preDestroy!(ctx);

    expect(result).toBeUndefined();
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
    expect(ctx.warn).not.toHaveBeenCalled();
  });
});

// ── 2. Happy path — one non-main association disassociated ───────────

describe("ec2RouteTableStrategy.preDestroy — disassociate subnet", () => {
  it("calls DisassociateRouteTable for a non-main, non-disassociated association", async () => {
    const ASSOC_ID = "rtbassoc-01234567890abcdef";
    mockEc2Send
      .mockResolvedValueOnce({
        RouteTables: [
          {
            Associations: [
              {
                RouteTableAssociationId: ASSOC_ID,
                Main: false,
                AssociationState: { State: "associated" },
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({}); // DisassociateRouteTableCommand

    const ctx = makeCtx();
    await ec2RouteTableStrategy.preDestroy!(ctx);

    expect(mockEc2Send.mock.calls[1]![0]).toMatchObject({
      _type: "DisassociateRouteTableCommand",
      input: { AssociationId: ASSOC_ID },
    });
    expect(ctx.warn).not.toHaveBeenCalled();
  });
});

// ── 3. Main association skipped ───────────────────────────────────────

describe("ec2RouteTableStrategy.preDestroy — main association skipped", () => {
  it("does NOT call Disassociate for Main=true associations", async () => {
    mockEc2Send.mockResolvedValueOnce({
      RouteTables: [
        {
          Associations: [
            {
              RouteTableAssociationId: "rtbassoc-main",
              Main: true,
              AssociationState: { State: "associated" },
            },
          ],
        },
      ],
    });

    const ctx = makeCtx();
    await ec2RouteTableStrategy.preDestroy!(ctx);

    expect(mockEc2Send).toHaveBeenCalledTimes(1);
    expect(ctx.warn).not.toHaveBeenCalled();
  });
});

// ── 4. Already-disassociated association skipped ──────────────────────

describe("ec2RouteTableStrategy.preDestroy — already disassociated", () => {
  it("skips associations with State=disassociated", async () => {
    mockEc2Send.mockResolvedValueOnce({
      RouteTables: [
        {
          Associations: [
            {
              RouteTableAssociationId: "rtbassoc-gone",
              Main: false,
              AssociationState: { State: "disassociated" },
            },
          ],
        },
      ],
    });

    const ctx = makeCtx();
    await ec2RouteTableStrategy.preDestroy!(ctx);

    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });
});

// ── 5. Per-association disassociate failure (non-fatal) ───────────────

describe("ec2RouteTableStrategy.preDestroy — per-association failure is non-fatal", () => {
  it("emits route_table_disassociate_failed warn but continues on disassociate error", async () => {
    const ASSOC_ID = "rtbassoc-willFail000";
    mockEc2Send
      .mockResolvedValueOnce({
        RouteTables: [
          {
            Associations: [
              {
                RouteTableAssociationId: ASSOC_ID,
                Main: false,
                AssociationState: { State: "associated" },
              },
            ],
          },
        ],
      })
      .mockRejectedValueOnce(new Error("DependencyViolation"));

    const ctx = makeCtx();
    const result = await ec2RouteTableStrategy.preDestroy!(ctx);

    expect(result).toBeUndefined();
    expect(ctx.warn).toHaveBeenCalledWith(
      "route_table_disassociate_failed",
      expect.objectContaining({ associationId: ASSOC_ID }),
    );
  });
});

// ── 6. DescribeRouteTables throws → non-fatal describe failure ─────────

describe("ec2RouteTableStrategy.preDestroy — describe fails", () => {
  it("warns route_table_describe_failed and returns void when Describe throws", async () => {
    mockEc2Send.mockRejectedValueOnce(new Error("Forbidden"));

    const ctx = makeCtx();
    const result = await ec2RouteTableStrategy.preDestroy!(ctx);

    expect(result).toBeUndefined();
    expect(ctx.warn).toHaveBeenCalledWith(
      "route_table_describe_failed",
      expect.objectContaining({ identifier: RT_ID }),
    );
  });
});

// ── 7. MissingAssigneeCredentialsError → hard failure ─────────────────

describe("ec2RouteTableStrategy.preDestroy — missing credentials", () => {
  it("returns hard failure when operator credentials are absent", async () => {
    mockRequireAssigneeCredentials.mockImplementation(() => {
      throw new MissingAssigneeCredentialsError(
        "operator",
        "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
        "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
      );
    });

    const ctx = makeCtx();
    const outcome = await ec2RouteTableStrategy.preDestroy!(ctx);

    expect(outcome?.success).toBe(false);
    expect(outcome?.error).toContain("Cannot disassociate RouteTable");
  });
});

// ── Strategy metadata ─────────────────────────────────────────────────

describe("ec2RouteTableStrategy metadata", () => {
  it("has the correct resourceType", () => {
    expect(ec2RouteTableStrategy.resourceType).toBe(
      RESOURCE_TYPES.EC2_ROUTE_TABLE,
    );
  });

  it("exposes only a preDestroy hook", () => {
    expect(typeof ec2RouteTableStrategy.preDestroy).toBe("function");
    expect(ec2RouteTableStrategy.destroy).toBeUndefined();
    expect(ec2RouteTableStrategy.postDestroy).toBeUndefined();
  });
});
