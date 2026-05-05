import { describe, it, expect, vi, beforeEach } from "vitest";
import { RESOURCE_TYPES } from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { cleanupAllocatedResources } from "./cleanup.js";
import type { SshIamCreated } from "./ssh-iam.js";

const { mockEc2Send, mockIamSend } = vi.hoisted(() => ({
  mockEc2Send: vi.fn(),
  mockIamSend: vi.fn(),
}));

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

vi.mock("@aws-sdk/client-iam", () => {
  class IAMClient {
    send = mockIamSend;
    destroy = vi.fn();
  }
  function RemoveRoleFromInstanceProfileCommand(input: unknown) {
    return { _type: "RemoveRoleFromInstanceProfileCommand", input };
  }
  function DeleteInstanceProfileCommand(input: unknown) {
    return { _type: "DeleteInstanceProfileCommand", input };
  }
  function DetachRolePolicyCommand(input: unknown) {
    return { _type: "DetachRolePolicyCommand", input };
  }
  function DeleteRoleCommand(input: unknown) {
    return { _type: "DeleteRoleCommand", input };
  }
  return {
    IAMClient,
    RemoveRoleFromInstanceProfileCommand,
    DeleteInstanceProfileCommand,
    DetachRolePolicyCommand,
    DeleteRoleCommand,
  };
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
    mockIamSend.mockReset();
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

  describe("SSH-bundle IAM teardown", () => {
    function fullCreated(): SshIamCreated {
      return {
        roleName: "assignee-ssh-abcdef12",
        profileName: "assignee-ssh-abcdef12",
        attachedPolicyArn:
          "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
        roleAddedToProfile: true,
      };
    }

    it("tears down all 4 IAM resources in order when sshIamCreated is fully populated", async () => {
      mockIamSend.mockResolvedValue({
        $metadata: { httpStatusCode: 200, requestId: "iam-cleanup-1" },
      });
      await cleanupAllocatedResources(
        baseState({ resourceType: RESOURCE_TYPES.EC2_INSTANCE }),
        {
          eipReleased: new Set(),
          sshDeleted: undefined,
          sshIamCreated: fullCreated(),
        },
      );
      const types = mockIamSend.mock.calls.map(
        (c) => (c[0] as { _type: string })._type,
      );
      // Order matters per IAM API:
      // RemoveRoleFromInstanceProfile → DeleteInstanceProfile →
      // DetachRolePolicy → DeleteRole.
      expect(types).toEqual([
        "RemoveRoleFromInstanceProfileCommand",
        "DeleteInstanceProfileCommand",
        "DetachRolePolicyCommand",
        "DeleteRoleCommand",
      ]);

      // Validate inputs.
      const remove = mockIamSend.mock.calls[0]![0] as {
        input: { InstanceProfileName: string; RoleName: string };
      };
      expect(remove.input.InstanceProfileName).toBe("assignee-ssh-abcdef12");
      expect(remove.input.RoleName).toBe("assignee-ssh-abcdef12");

      const delProfile = mockIamSend.mock.calls[1]![0] as {
        input: { InstanceProfileName: string };
      };
      expect(delProfile.input.InstanceProfileName).toBe(
        "assignee-ssh-abcdef12",
      );

      const detach = mockIamSend.mock.calls[2]![0] as {
        input: { RoleName: string; PolicyArn: string };
      };
      expect(detach.input.RoleName).toBe("assignee-ssh-abcdef12");
      expect(detach.input.PolicyArn).toBe(
        "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
      );

      const delRole = mockIamSend.mock.calls[3]![0] as {
        input: { RoleName: string };
      };
      expect(delRole.input.RoleName).toBe("assignee-ssh-abcdef12");
    });

    it("skips RemoveRoleFromInstanceProfile when roleAddedToProfile is false", async () => {
      mockIamSend.mockResolvedValue({
        $metadata: { httpStatusCode: 200 },
      });
      await cleanupAllocatedResources(
        baseState({ resourceType: RESOURCE_TYPES.EC2_INSTANCE }),
        {
          eipReleased: new Set(),
          sshDeleted: undefined,
          sshIamCreated: { ...fullCreated(), roleAddedToProfile: false },
        },
      );
      const types = mockIamSend.mock.calls.map(
        (c) => (c[0] as { _type: string })._type,
      );
      expect(types).toEqual([
        "DeleteInstanceProfileCommand",
        "DetachRolePolicyCommand",
        "DeleteRoleCommand",
      ]);
    });

    it("only deletes the role when only roleName is set (Step 1 succeeded but later steps failed)", async () => {
      mockIamSend.mockResolvedValue({
        $metadata: { httpStatusCode: 200 },
      });
      await cleanupAllocatedResources(
        baseState({ resourceType: RESOURCE_TYPES.EC2_INSTANCE }),
        {
          eipReleased: new Set(),
          sshDeleted: undefined,
          sshIamCreated: {
            roleName: "assignee-ssh-abcdef12",
            profileName: undefined,
            attachedPolicyArn: undefined,
            roleAddedToProfile: false,
          },
        },
      );
      const types = mockIamSend.mock.calls.map(
        (c) => (c[0] as { _type: string })._type,
      );
      expect(types).toEqual(["DeleteRoleCommand"]);
    });

    it("is a no-op when sshIamCreated is undefined", async () => {
      await cleanupAllocatedResources(
        baseState({ resourceType: RESOURCE_TYPES.EC2_INSTANCE }),
        { eipReleased: new Set(), sshDeleted: undefined },
      );
      expect(mockIamSend).not.toHaveBeenCalled();
    });

    it("is a no-op when sshIamCreated has all fields undefined/false", async () => {
      await cleanupAllocatedResources(
        baseState({ resourceType: RESOURCE_TYPES.EC2_INSTANCE }),
        {
          eipReleased: new Set(),
          sshDeleted: undefined,
          sshIamCreated: {
            roleName: undefined,
            profileName: undefined,
            attachedPolicyArn: undefined,
            roleAddedToProfile: false,
          },
        },
      );
      expect(mockIamSend).not.toHaveBeenCalled();
    });

    it("swallows NoSuchEntity / NotFound errors (best-effort)", async () => {
      const noSuchEntity = Object.assign(new Error("Role not found"), {
        name: "NoSuchEntityException",
      });
      mockIamSend.mockRejectedValue(noSuchEntity);
      await expect(
        cleanupAllocatedResources(
          baseState({ resourceType: RESOURCE_TYPES.EC2_INSTANCE }),
          {
            eipReleased: new Set(),
            sshDeleted: undefined,
            sshIamCreated: fullCreated(),
          },
        ),
      ).resolves.not.toThrow();
      // All 4 calls were attempted (best-effort means each call is tried
      // independently — one failing doesn't stop the next).
      expect(mockIamSend).toHaveBeenCalledTimes(4);
    });

    it("teardown runs alongside SSH key + EIP release without interference", async () => {
      mockEc2Send.mockResolvedValue({
        $metadata: { httpStatusCode: 200 },
      });
      mockIamSend.mockResolvedValue({
        $metadata: { httpStatusCode: 200 },
      });
      await cleanupAllocatedResources(
        baseState({ resourceType: RESOURCE_TYPES.EC2_INSTANCE }),
        {
          eipReleased: new Set(),
          sshDeleted: "assignee-ssh-key",
          sshIamCreated: fullCreated(),
        },
      );
      // 4 IAM calls + 1 EC2 DeleteKeyPair call.
      expect(mockIamSend).toHaveBeenCalledTimes(4);
      expect(mockEc2Send).toHaveBeenCalledTimes(1);
      const ec2Type = (mockEc2Send.mock.calls[0]![0] as { _type: string })
        ._type;
      expect(ec2Type).toBe("DeleteKeyPairCommand");
    });

    it("is idempotent: calling twice does not throw", async () => {
      mockIamSend.mockResolvedValue({
        $metadata: { httpStatusCode: 200 },
      });
      const inputs = {
        eipReleased: new Set<string>(),
        sshDeleted: undefined,
        sshIamCreated: fullCreated(),
      };
      await cleanupAllocatedResources(
        baseState({ resourceType: RESOURCE_TYPES.EC2_INSTANCE }),
        inputs,
      );
      await cleanupAllocatedResources(
        baseState({ resourceType: RESOURCE_TYPES.EC2_INSTANCE }),
        inputs,
      );
      expect(mockIamSend).toHaveBeenCalledTimes(8);
    });
  });
});
