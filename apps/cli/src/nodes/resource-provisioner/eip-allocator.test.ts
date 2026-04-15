import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CfnKey,
  EIP_AUTO_ALLOCATE,
  ExecutionStatus,
  RESOURCE_TYPES,
} from "@assignee/core";
import type { AgentState } from "../../services/graph-state.js";
import { allocateNatGatewayEip } from "./eip-allocator.js";

const { mockEc2Send } = vi.hoisted(() => ({ mockEc2Send: vi.fn() }));

vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = mockEc2Send;
  }
  function AllocateAddressCommand(input: unknown) {
    return { _type: "AllocateAddressCommand", input };
  }
  function DescribeAddressesCommand(input: unknown) {
    return { _type: "DescribeAddressesCommand", input };
  }
  function CreateTagsCommand(input: unknown) {
    return { _type: "CreateTagsCommand", input };
  }
  function ReleaseAddressCommand(input: unknown) {
    return { _type: "ReleaseAddressCommand", input };
  }
  return {
    EC2Client,
    AllocateAddressCommand,
    DescribeAddressesCommand,
    CreateTagsCommand,
    ReleaseAddressCommand,
  };
});

vi.mock("../../config/aws-credentials.js", () => ({
  requireAssigneeCredentials: () => ({
    accessKeyId: "AKIATEST",
    secretAccessKey: "secret",
  }),
}));

function baseState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    runId: "run-eip-001",
    resourceType: RESOURCE_TYPES.EC2_NAT_GATEWAY,
    ...overrides,
  } as unknown as AgentState;
}

describe("allocateNatGatewayEip", () => {
  beforeEach(() => {
    mockEc2Send.mockReset();
  });

  it("no-ops for non-NatGateway resources", async () => {
    const r = await allocateNatGatewayEip(
      baseState({ resourceType: RESOURCE_TYPES.S3_BUCKET }),
      {},
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.freshlyAllocated.size).toBe(0);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it("no-ops when AllocationId is not the placeholder", async () => {
    const r = await allocateNatGatewayEip(baseState(), {
      [CfnKey.ALLOCATION_ID]: "eipalloc-user-supplied",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.freshlyAllocated.size).toBe(0);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it("allocates a fresh EIP and tags with runId + managed-by", async () => {
    mockEc2Send
      .mockResolvedValueOnce({ Addresses: [] }) // DescribeAddresses (no reuse)
      .mockResolvedValueOnce({ AllocationId: "eipalloc-new-123" }) // AllocateAddress
      .mockResolvedValueOnce({}); // CreateTags
    const desired: Record<string, unknown> = {
      [CfnKey.ALLOCATION_ID]: EIP_AUTO_ALLOCATE,
    };
    const r = await allocateNatGatewayEip(baseState(), desired);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.freshlyAllocated.has("eipalloc-new-123")).toBe(true);
    }
    expect(desired[CfnKey.ALLOCATION_ID]).toBe("eipalloc-new-123");
    const tagCall = mockEc2Send.mock.calls.find(
      (c) => (c[0] as { _type: string })._type === "CreateTagsCommand",
    );
    expect(tagCall).toBeTruthy();
    const tags = (
      tagCall![0] as { input: { Tags: Array<{ Key: string; Value: string }> } }
    ).input.Tags;
    expect(tags.find((t) => t.Key === "assignee:runId")?.Value).toBe(
      "run-eip-001",
    );
    expect(tags.find((t) => t.Key === "managed-by")?.Value).toBeDefined();
  });

  it("reuses an existing EIP tagged with runId (no fresh allocation)", async () => {
    mockEc2Send.mockResolvedValueOnce({
      Addresses: [{ AllocationId: "eipalloc-reuse-888" }],
    });
    const desired: Record<string, unknown> = {
      [CfnKey.ALLOCATION_ID]: EIP_AUTO_ALLOCATE,
    };
    const r = await allocateNatGatewayEip(baseState(), desired);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // CRITICAL: reused EIP must NOT be in freshlyAllocated — cleanup would
      // release it on failure otherwise.
      expect(r.freshlyAllocated.size).toBe(0);
    }
    expect(desired[CfnKey.ALLOCATION_ID]).toBe("eipalloc-reuse-888");
  });

  it("auto-releases orphan EIPs (L-A6 leak recovery)", async () => {
    mockEc2Send
      .mockResolvedValueOnce({
        Addresses: [
          { AllocationId: "eipalloc-keep-1" },
          // orphan — no AssociationId/InstanceId/NetworkInterfaceId
          { AllocationId: "eipalloc-orphan-2" },
          // associated — must be kept
          {
            AllocationId: "eipalloc-assoc-3",
            AssociationId: "eipassoc-1",
          },
        ],
      })
      .mockResolvedValueOnce({}); // ReleaseAddress for orphan
    const desired: Record<string, unknown> = {
      [CfnKey.ALLOCATION_ID]: EIP_AUTO_ALLOCATE,
    };
    const r = await allocateNatGatewayEip(baseState(), desired);
    expect(r.ok).toBe(true);
    const releaseCalls = mockEc2Send.mock.calls.filter(
      (c) => (c[0] as { _type: string })._type === "ReleaseAddressCommand",
    );
    expect(releaseCalls).toHaveLength(1);
    expect(
      (releaseCalls[0]![0] as { input: { AllocationId: string } }).input
        .AllocationId,
    ).toBe("eipalloc-orphan-2");
  });

  it("falls through to fresh allocation on DescribeAddresses AccessDenied", async () => {
    const ad = new Error("AccessDenied");
    (ad as { name?: string }).name = "AccessDeniedException";
    mockEc2Send
      .mockRejectedValueOnce(ad)
      .mockResolvedValueOnce({ AllocationId: "eipalloc-fallback" })
      .mockResolvedValueOnce({});
    const desired: Record<string, unknown> = {
      [CfnKey.ALLOCATION_ID]: EIP_AUTO_ALLOCATE,
    };
    const r = await allocateNatGatewayEip(baseState(), desired);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.freshlyAllocated.has("eipalloc-fallback")).toBe(true);
    }
  });

  it("FAILS when AllocateAddress returns no AllocationId", async () => {
    mockEc2Send
      .mockResolvedValueOnce({ Addresses: [] })
      .mockResolvedValueOnce({}); // No AllocationId
    const desired: Record<string, unknown> = {
      [CfnKey.ALLOCATION_ID]: EIP_AUTO_ALLOCATE,
    };
    const r = await allocateNatGatewayEip(baseState(), desired);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.partial.executionStatus).toBe(ExecutionStatus.FAILED);
      expect(r.partial.errorMessage).toContain("no AllocationId");
    }
  });

  it("treats tagging failure as non-fatal (EIP is usable)", async () => {
    mockEc2Send
      .mockResolvedValueOnce({ Addresses: [] })
      .mockResolvedValueOnce({ AllocationId: "eipalloc-tag-fail" })
      .mockRejectedValueOnce(new Error("TaggingThrottled"));
    const desired: Record<string, unknown> = {
      [CfnKey.ALLOCATION_ID]: EIP_AUTO_ALLOCATE,
    };
    const r = await allocateNatGatewayEip(baseState(), desired);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.freshlyAllocated.has("eipalloc-tag-fail")).toBe(true);
    }
    expect(desired[CfnKey.ALLOCATION_ID]).toBe("eipalloc-tag-fail");
  });
});
