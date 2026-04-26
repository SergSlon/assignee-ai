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

  it("resolves placeholder to the first AVAILABLE subnet in the default VPC", async () => {
    mockTryCredentials.mockReturnValue(READER_CREDS);
    mockEc2Send
      .mockResolvedValueOnce({
        // DescribeVpcs response — one default VPC in available state
        Vpcs: [{ VpcId: "vpc-0abc1234default", State: "available" }],
      })
      .mockResolvedValueOnce({
        // DescribeSubnets response — pending subnet first, then available;
        // HIGH-1: must skip the pending one and pick the available subnet
        Subnets: [
          { SubnetId: "subnet-0pending", State: "pending" },
          { SubnetId: "subnet-0first123", State: "available" },
          { SubnetId: "subnet-0second456", State: "available" },
        ],
      });

    const desiredState: Record<string, unknown> = {
      [CfnKey.SUBNET_ID]: ResourceDefault.SUBNET_PLACEHOLDER,
    };
    const r = await ensureSubnet(baseState(), desiredState);
    expect(r.ok).toBe(true);
    // Must skip pending subnet and resolve to first available
    expect(desiredState[CfnKey.SUBNET_ID]).toBe("subnet-0first123");
  });

  it("emits a private-subnet WARNING but still resolves when MapPublicIpOnLaunch=false (HIGH-2)", async () => {
    mockTryCredentials.mockReturnValue(READER_CREDS);
    mockEc2Send
      .mockResolvedValueOnce({
        Vpcs: [{ VpcId: "vpc-0abc1234default", State: "available" }],
      })
      .mockResolvedValueOnce({
        Subnets: [
          {
            SubnetId: "subnet-0private1",
            State: "available",
            MapPublicIpOnLaunch: false,
          },
        ],
      });

    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        stderrWrites.push(typeof chunk === "string" ? chunk : "");
        return origWrite(chunk);
      },
    );

    const desiredState: Record<string, unknown> = {
      [CfnKey.SUBNET_ID]: ResourceDefault.SUBNET_PLACEHOLDER,
    };
    const r = await ensureSubnet(baseState(), desiredState);

    vi.restoreAllMocks();

    // Must succeed (not fail) even for private subnets
    expect(r.ok).toBe(true);
    expect(desiredState[CfnKey.SUBNET_ID]).toBe("subnet-0private1");
    // Must warn about private subnet
    const warnText = stderrWrites.join("");
    expect(warnText).toContain("MapPublicIpOnLaunch=false");
    expect(warnText).toContain("--set SubnetId=");
  });

  it("HIGH-2: does NOT warn when MapPublicIpOnLaunch=true", async () => {
    mockTryCredentials.mockReturnValue(READER_CREDS);
    mockEc2Send
      .mockResolvedValueOnce({
        Vpcs: [{ VpcId: "vpc-0abc1234default", State: "available" }],
      })
      .mockResolvedValueOnce({
        Subnets: [
          {
            SubnetId: "subnet-0public1",
            State: "available",
            MapPublicIpOnLaunch: true,
          },
        ],
      });

    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        stderrWrites.push(typeof chunk === "string" ? chunk : "");
        return true;
      },
    );

    const desiredState: Record<string, unknown> = {
      [CfnKey.SUBNET_ID]: ResourceDefault.SUBNET_PLACEHOLDER,
    };
    const r = await ensureSubnet(baseState(), desiredState);
    vi.restoreAllMocks();

    expect(r.ok).toBe(true);
    expect(desiredState[CfnKey.SUBNET_ID]).toBe("subnet-0public1");
    const warnText = stderrWrites.join("");
    expect(warnText).not.toContain("MapPublicIpOnLaunch=false");
  });

  it("HIGH-3: no-ops when SubnetId is already a resolved value (retry path)", async () => {
    mockTryCredentials.mockReturnValue(READER_CREDS);
    const desiredState: Record<string, unknown> = {
      [CfnKey.SUBNET_ID]: "subnet-0alreadyresolved",
    };
    const r = await ensureSubnet(baseState(), desiredState);
    expect(r.ok).toBe(true);
    // No AWS calls made — using cached value
    expect(mockEc2Send).not.toHaveBeenCalled();
    // Cached value unchanged
    expect(desiredState[CfnKey.SUBNET_ID]).toBe("subnet-0alreadyresolved");
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

  it("MED-1: returns error when default VPC is in deleting state", async () => {
    mockTryCredentials.mockReturnValue(READER_CREDS);
    mockEc2Send.mockResolvedValueOnce({
      Vpcs: [{ VpcId: "vpc-0deleting", State: "deleting" }],
    });

    const desiredState: Record<string, unknown> = {
      [CfnKey.SUBNET_ID]: ResourceDefault.SUBNET_PLACEHOLDER,
    };
    const r = await ensureSubnet(baseState(), desiredState);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain("vpc-0deleting");
      expect(r.errorMessage).toContain('"deleting"');
      expect(r.errorMessage).toContain("available");
    }
  });

  it("HIGH-1: returns error when all subnets are in pending/deleting state", async () => {
    mockTryCredentials.mockReturnValue(READER_CREDS);
    mockEc2Send
      .mockResolvedValueOnce({
        Vpcs: [{ VpcId: "vpc-0abc1234", State: "available" }],
      })
      .mockResolvedValueOnce({
        Subnets: [
          { SubnetId: "subnet-0pending1", State: "pending" },
          { SubnetId: "subnet-0deleting1", State: "deleting" },
        ],
      });

    const desiredState: Record<string, unknown> = {
      [CfnKey.SUBNET_ID]: ResourceDefault.SUBNET_PLACEHOLDER,
    };
    const r = await ensureSubnet(baseState(), desiredState);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain("available");
      expect(r.errorMessage).toContain("vpc-0abc1234");
    }
  });

  it("returns actionable error when default VPC has no subnets", async () => {
    mockTryCredentials.mockReturnValue(READER_CREDS);
    mockEc2Send
      .mockResolvedValueOnce({
        Vpcs: [{ VpcId: "vpc-0nosubnets", State: "available" }],
      })
      .mockResolvedValueOnce({ Subnets: [] });

    const desiredState: Record<string, unknown> = {
      [CfnKey.SUBNET_ID]: ResourceDefault.SUBNET_PLACEHOLDER,
    };
    const r = await ensureSubnet(baseState(), desiredState);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorMessage).toContain("vpc-0nosubnets");
      expect(r.errorMessage).toContain("available");
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
