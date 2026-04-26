import { describe, it, expect, vi, beforeEach } from "vitest";
import { CfnKey, RESOURCE_TYPES, ResourceDefault } from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { ensureSubnet } from "./subnet.js";

const { mockEc2Send } = vi.hoisted(() => ({ mockEc2Send: vi.fn() }));

vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = mockEc2Send;
    destroy = vi.fn();
  }
  function DescribeVpcsCommand(input: unknown) {
    return { _type: "DescribeVpcsCommand", input };
  }
  function DescribeSubnetsCommand(input: unknown) {
    return { _type: "DescribeSubnetsCommand", input };
  }
  return { EC2Client, DescribeVpcsCommand, DescribeSubnetsCommand };
});

// Mock tryAssigneeCredentials — override per test via the hoisted mock below
const { mockTryCredentials } = vi.hoisted(() => ({
  mockTryCredentials: vi.fn(),
}));

vi.mock("../../../config/aws-credentials.js", () => ({
  tryAssigneeCredentials: mockTryCredentials,
}));

const READER_CREDS = { accessKeyId: "AKIAREADER", secretAccessKey: "secret" };

function baseState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    runId: "run-subnet-001",
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    ...overrides,
  } as unknown as AgentState;
}

describe("ensureSubnet", () => {
  beforeEach(() => {
    mockEc2Send.mockReset();
    mockTryCredentials.mockReset();
  });

  // ── No-op cases ────────────────────────────────────────────────────────────

  it("no-ops for non-EC2::Instance resources", async () => {
    const desiredState: Record<string, unknown> = {
      [CfnKey.SUBNET_ID]: ResourceDefault.SUBNET_PLACEHOLDER,
    };
    const r = await ensureSubnet(
      baseState({ resourceType: RESOURCE_TYPES.S3_BUCKET }),
      desiredState,
    );
    expect(r.ok).toBe(true);
    expect(mockEc2Send).not.toHaveBeenCalled();
    // desiredState is unchanged — no-op
    expect(desiredState[CfnKey.SUBNET_ID]).toBe(
      ResourceDefault.SUBNET_PLACEHOLDER,
    );
  });

  it("no-ops when SubnetId is a real subnet ID (not placeholder)", async () => {
    const desiredState: Record<string, unknown> = {
      [CfnKey.SUBNET_ID]: "subnet-0a1b2c3d4e5f",
    };
    const r = await ensureSubnet(baseState(), desiredState);
    expect(r.ok).toBe(true);
    expect(mockEc2Send).not.toHaveBeenCalled();
    expect(desiredState[CfnKey.SUBNET_ID]).toBe("subnet-0a1b2c3d4e5f");
  });

  it("no-ops when SubnetId is absent", async () => {
    const desiredState: Record<string, unknown> = {};
    const r = await ensureSubnet(baseState(), desiredState);
    expect(r.ok).toBe(true);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  // ── No reader credentials ──────────────────────────────────────────────────

  it("clears placeholder and returns ok when reader creds are absent", async () => {
    mockTryCredentials.mockReturnValue(undefined);
    const desiredState: Record<string, unknown> = {
      [CfnKey.SUBNET_ID]: ResourceDefault.SUBNET_PLACEHOLDER,
    };
    const r = await ensureSubnet(baseState(), desiredState);
    expect(r.ok).toBe(true);
    // Placeholder must be cleared so CCAPI doesn't receive the sentinel string
    expect(desiredState[CfnKey.SUBNET_ID]).toBeUndefined();
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it("resolves placeholder to the first subnet in the default VPC", async () => {
    mockTryCredentials.mockReturnValue(READER_CREDS);
    mockEc2Send
      .mockResolvedValueOnce({
        // DescribeVpcs response — one default VPC
        Vpcs: [{ VpcId: "vpc-0abc1234default" }],
      })
      .mockResolvedValueOnce({
        // DescribeSubnets response — two subnets; picks the first
        Subnets: [
          { SubnetId: "subnet-0first123" },
          { SubnetId: "subnet-0second456" },
        ],
      });

    const desiredState: Record<string, unknown> = {
      [CfnKey.SUBNET_ID]: ResourceDefault.SUBNET_PLACEHOLDER,
    };
    const r = await ensureSubnet(baseState(), desiredState);
    expect(r.ok).toBe(true);
    expect(desiredState[CfnKey.SUBNET_ID]).toBe("subnet-0first123");
  });

  // ── Error paths ────────────────────────────────────────────────────────────

  it("returns actionable error when no default VPC exists", async () => {
    mockTryCredentials.mockReturnValue(READER_CREDS);
    mockEc2Send.mockResolvedValueOnce({ Vpcs: [] });

    const desiredState: Record<string, unknown> = {
      [CfnKey.SUBNET_ID]: ResourceDefault.SUBNET_PLACEHOLDER,
    };
    const r = await ensureSubnet(baseState(), desiredState);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain("No default VPC");
      expect(r.errorMessage).toContain("assignee apply");
    }
  });

  it("returns actionable error when default VPC has no subnets", async () => {
    mockTryCredentials.mockReturnValue(READER_CREDS);
    mockEc2Send
      .mockResolvedValueOnce({ Vpcs: [{ VpcId: "vpc-0nosubnets" }] })
      .mockResolvedValueOnce({ Subnets: [] });

    const desiredState: Record<string, unknown> = {
      [CfnKey.SUBNET_ID]: ResourceDefault.SUBNET_PLACEHOLDER,
    };
    const r = await ensureSubnet(baseState(), desiredState);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain("vpc-0nosubnets");
      expect(r.errorMessage).toContain("no subnets");
    }
  });

  it("returns actionable error when DescribeVpcs throws (IAM permission missing)", async () => {
    mockTryCredentials.mockReturnValue(READER_CREDS);
    mockEc2Send.mockRejectedValueOnce(
      new Error(
        "AccessDeniedException: not authorized to perform ec2:DescribeVpcs",
      ),
    );

    const desiredState: Record<string, unknown> = {
      [CfnKey.SUBNET_ID]: ResourceDefault.SUBNET_PLACEHOLDER,
    };
    const r = await ensureSubnet(baseState(), desiredState);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain("AccessDeniedException");
      expect(r.errorMessage).toContain("ec2:DescribeVpcs");
      // Must mention manual fallback
      expect(r.errorMessage).toContain("--set SubnetId=");
    }
  });

  it("DescribeVpcs returning undefined Vpcs array is treated as no-default-VPC", async () => {
    mockTryCredentials.mockReturnValue(READER_CREDS);
    mockEc2Send.mockResolvedValueOnce({ Vpcs: undefined });

    const desiredState: Record<string, unknown> = {
      [CfnKey.SUBNET_ID]: ResourceDefault.SUBNET_PLACEHOLDER,
    };
    const r = await ensureSubnet(baseState(), desiredState);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain("No default VPC");
    }
  });
});
