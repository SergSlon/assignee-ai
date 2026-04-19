import { describe, it, expect, vi, beforeEach } from "vitest";
import { RESOURCE_TYPES } from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { cleanupAllocatedResources } from "./cleanup.js";

const { mockEc2Send } = vi.hoisted(() => ({ mockEc2Send: vi.fn() }));

vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = mockEc2Send;
    destroy = vi.fn();
  }
  function ReleaseAddressCommand(input: unknown) {
    return { _type: "ReleaseAddressCommand", input };
  }
  function DeleteKeyPairCommand(input: unknown) {
    return { _type: "DeleteKeyPairCommand", input };
  }
  return { EC2Client, ReleaseAddressCommand, DeleteKeyPairCommand };
});

vi.mock("../../../config/aws-credentials.js", () => ({
  requireAssigneeCredentials: () => ({
    accessKeyId: "AKIATEST",
    secretAccessKey: "secret",
  }),
}));

function baseState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    runId: "run-cleanup-001",
    resourceType: RESOURCE_TYPES.EC2_NAT_GATEWAY,
    ...overrides,
  } as unknown as AgentState;
}

describe("cleanupAllocatedResources", () => {
  beforeEach(() => {
    mockEc2Send.mockReset();
  });

  it("releases every freshly-allocated EIP for NatGateway", async () => {
    // ReleaseAddressCommand returns an empty-body success response; the real
    // AWS SDK shape is just `$metadata`. Documenting it explicitly so the
    // mock can't drift from the production contract.
    mockEc2Send.mockResolvedValue({
      $metadata: { httpStatusCode: 200, requestId: "test-req-1" },
    });
    await cleanupAllocatedResources(baseState(), {
      eipReleased: new Set(["eipalloc-111", "eipalloc-222"]),
      sshDeleted: undefined,
    });
    const releaseCalls = mockEc2Send.mock.calls.filter(
      (c) => (c[0] as { _type: string })._type === "ReleaseAddressCommand",
    );
    expect(releaseCalls).toHaveLength(2);
    expect(
      releaseCalls.map(
        (c) => (c[0] as { input: { AllocationId: string } }).input.AllocationId,
      ),
    ).toEqual(["eipalloc-111", "eipalloc-222"]);
  });

  it("is a no-op when eipReleased is empty and sshDeleted is undefined", async () => {
    await cleanupAllocatedResources(baseState(), {
      eipReleased: new Set(),
      sshDeleted: undefined,
    });
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it("does NOT release EIPs when resourceType is not NatGateway", async () => {
    await cleanupAllocatedResources(
      baseState({ resourceType: RESOURCE_TYPES.EC2_INSTANCE }),
      { eipReleased: new Set(["eipalloc-111"]), sshDeleted: undefined },
    );
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it("swallows ReleaseAddress errors (best-effort)", async () => {
    mockEc2Send.mockRejectedValue(new Error("InvalidAllocationID.NotFound"));
    await expect(
      cleanupAllocatedResources(baseState(), {
        eipReleased: new Set(["eipalloc-111"]),
        sshDeleted: undefined,
      }),
    ).resolves.not.toThrow();
  });

  it("deletes the SSH key pair when sshDeleted is set", async () => {
    // DeleteKeyPairCommand returns an empty-body success response; the real
    // AWS SDK shape is just `$metadata`.
    mockEc2Send.mockResolvedValue({
      $metadata: { httpStatusCode: 200, requestId: "test-req-2" },
    });
    await cleanupAllocatedResources(
      baseState({ resourceType: RESOURCE_TYPES.EC2_INSTANCE }),
      { eipReleased: new Set(), sshDeleted: "my-key" },
    );
    const deleteCalls = mockEc2Send.mock.calls.filter(
      (c) => (c[0] as { _type: string })._type === "DeleteKeyPairCommand",
    );
    expect(deleteCalls).toHaveLength(1);
    expect(
      (deleteCalls[0]![0] as { input: { KeyName: string } }).input.KeyName,
    ).toBe("my-key");
  });

  it("swallows DeleteKeyPair errors (best-effort)", async () => {
    mockEc2Send.mockRejectedValue(new Error("Throttling"));
    await expect(
      cleanupAllocatedResources(
        baseState({ resourceType: RESOURCE_TYPES.EC2_INSTANCE }),
        { eipReleased: new Set(), sshDeleted: "my-key" },
      ),
    ).resolves.not.toThrow();
  });

  it("is idempotent: calling twice with same inputs does not throw", async () => {
    // Blanket resolver for both ReleaseAddressCommand and DeleteKeyPairCommand
    // — both are empty-body success responses whose only real field is
    // `$metadata`.
    mockEc2Send.mockResolvedValue({
      $metadata: { httpStatusCode: 200, requestId: "test-req-3" },
    });
    const inputs = {
      eipReleased: new Set(["eipalloc-111"]),
      sshDeleted: "my-key",
    };
    await cleanupAllocatedResources(
      baseState({ resourceType: RESOURCE_TYPES.EC2_INSTANCE }),
      inputs,
    );
    await cleanupAllocatedResources(
      baseState({ resourceType: RESOURCE_TYPES.EC2_INSTANCE }),
      inputs,
    );
    // No assertion error = idempotent.
    expect(mockEc2Send).toHaveBeenCalled();
  });
});
