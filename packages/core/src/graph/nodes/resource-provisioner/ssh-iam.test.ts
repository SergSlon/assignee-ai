import { describe, it, expect, vi, beforeEach } from "vitest";
import { CfnKey, ExecutionStatus, RESOURCE_TYPES } from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { ensureSshIamProfile } from "./ssh-iam.js";

const { mockIamSend } = vi.hoisted(() => ({ mockIamSend: vi.fn() }));

vi.mock("@aws-sdk/client-iam", () => {
  class IAMClient {
    send = mockIamSend;
    destroy = vi.fn();
  }
  function CreateRoleCommand(input: unknown) {
    return { _type: "CreateRoleCommand", input };
  }
  function AttachRolePolicyCommand(input: unknown) {
    return { _type: "AttachRolePolicyCommand", input };
  }
  function CreateInstanceProfileCommand(input: unknown) {
    return { _type: "CreateInstanceProfileCommand", input };
  }
  function AddRoleToInstanceProfileCommand(input: unknown) {
    return { _type: "AddRoleToInstanceProfileCommand", input };
  }
  function TagInstanceProfileCommand(input: unknown) {
    return { _type: "TagInstanceProfileCommand", input };
  }
  return {
    IAMClient,
    CreateRoleCommand,
    AttachRolePolicyCommand,
    CreateInstanceProfileCommand,
    AddRoleToInstanceProfileCommand,
    TagInstanceProfileCommand,
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
    runId: "abcdef1234567890",
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    userIntent: "Create a EC2 with SSH",
    ...overrides,
  } as unknown as AgentState;
}

function commandTypes(): string[] {
  return mockIamSend.mock.calls.map((c) => (c[0] as { _type: string })._type);
}

describe("ensureSshIamProfile", () => {
  beforeEach(() => {
    mockIamSend.mockReset();
  });

  it("no-ops when resourceType is not EC2::Instance", async () => {
    const desired: Record<string, unknown> = {};
    const r = await ensureSshIamProfile(
      baseState({ resourceType: RESOURCE_TYPES.S3_BUCKET }),
      desired,
    );
    expect(r.ok).toBe(true);
    expect(mockIamSend).not.toHaveBeenCalled();
    expect(desired[CfnKey.IAM_INSTANCE_PROFILE]).toBeUndefined();
  });

  it("no-ops when userIntent has no 'ssh' word", async () => {
    const desired: Record<string, unknown> = {};
    const r = await ensureSshIamProfile(
      baseState({ userIntent: "Create a t3.micro EC2" }),
      desired,
    );
    expect(r.ok).toBe(true);
    expect(mockIamSend).not.toHaveBeenCalled();
    expect(desired[CfnKey.IAM_INSTANCE_PROFILE]).toBeUndefined();
  });

  it("no-ops when user already supplied an IamInstanceProfile string", async () => {
    const desired: Record<string, unknown> = {
      [CfnKey.IAM_INSTANCE_PROFILE]: "my-existing-profile",
    };
    const r = await ensureSshIamProfile(baseState(), desired);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.created.profileName).toBeUndefined();
    expect(mockIamSend).not.toHaveBeenCalled();
    expect(desired[CfnKey.IAM_INSTANCE_PROFILE]).toBe("my-existing-profile");
  });

  it("no-ops when user supplied an IamInstanceProfile object with Arn", async () => {
    const desired: Record<string, unknown> = {
      [CfnKey.IAM_INSTANCE_PROFILE]: {
        Arn: "arn:aws:iam::123456789012:instance-profile/mine",
      },
    };
    const r = await ensureSshIamProfile(baseState(), desired);
    expect(r.ok).toBe(true);
    expect(mockIamSend).not.toHaveBeenCalled();
  });

  it("creates role + profile + tags + attaches policy + adds role to profile (happy path)", async () => {
    // Real-shape success responses — every IAM Create* / Attach* / AddRole* /
    // Tag* call returns just $metadata on success; we mirror that to keep
    // the mock honest with the production contract.
    mockIamSend.mockResolvedValue({
      $metadata: { httpStatusCode: 200, requestId: "test-req-1" },
    });

    const desired: Record<string, unknown> = {};
    const r = await ensureSshIamProfile(baseState(), desired);

    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");

    // 5 IAM calls in order: CreateRole (with Tags inline),
    // AttachRolePolicy, CreateInstanceProfile, TagInstanceProfile,
    // AddRoleToInstanceProfile.
    expect(commandTypes()).toEqual([
      "CreateRoleCommand",
      "AttachRolePolicyCommand",
      "CreateInstanceProfileCommand",
      "TagInstanceProfileCommand",
      "AddRoleToInstanceProfileCommand",
    ]);

    // Naming: assignee-ssh-<first 8 chars of runId>
    const expectedName = "assignee-ssh-abcdef12";
    expect(r.created.roleName).toBe(expectedName);
    expect(r.created.profileName).toBe(expectedName);
    expect(r.created.roleAddedToProfile).toBe(true);
    expect(desired[CfnKey.IAM_INSTANCE_PROFILE]).toBe(expectedName);

    // Validate the CreateRole AssumeRolePolicy targets ec2.amazonaws.com.
    const createRole = mockIamSend.mock.calls[0]![0] as {
      input: {
        RoleName: string;
        AssumeRolePolicyDocument: string;
        Tags?: Array<{ Key: string; Value: string }>;
      };
    };
    expect(createRole.input.RoleName).toBe(expectedName);
    const policyDoc = JSON.parse(createRole.input.AssumeRolePolicyDocument) as {
      Statement: Array<{ Principal: { Service: string } }>;
    };
    expect(policyDoc.Statement[0]!.Principal.Service).toBe("ec2.amazonaws.com");

    // Managed policy ARN is partition-aware; default test region resolves
    // to commercial 'aws' partition.
    const attach = mockIamSend.mock.calls[1]![0] as {
      input: { RoleName: string; PolicyArn: string };
    };
    expect(attach.input.RoleName).toBe(expectedName);
    expect(attach.input.PolicyArn).toBe(
      "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    );
    expect(r.created.attachedPolicyArn).toBe(attach.input.PolicyArn);

    // Profile create + tag + role association.
    const createProfile = mockIamSend.mock.calls[2]![0] as {
      input: { InstanceProfileName: string };
    };
    expect(createProfile.input.InstanceProfileName).toBe(expectedName);
    const tagProfile = mockIamSend.mock.calls[3]![0] as {
      input: {
        InstanceProfileName: string;
        Tags: Array<{ Key: string; Value: string }>;
      };
    };
    expect(tagProfile.input.InstanceProfileName).toBe(expectedName);
    const addRole = mockIamSend.mock.calls[4]![0] as {
      input: { InstanceProfileName: string; RoleName: string };
    };
    expect(addRole.input.InstanceProfileName).toBe(expectedName);
    expect(addRole.input.RoleName).toBe(expectedName);
  });

  it("CreateRole tags managed-by=assignee-ai + assignee-run-id=<runId>", async () => {
    // BLOCKER #2: untagged roles are invisible to
    // `assignee destroy --include-iam` per feedback_iam_role_rgta_gap.
    // The role MUST carry both tags so the destroy enumeration via
    // iam:ListRoles + iam:ListRoleTags filtered by managed-by finds it.
    mockIamSend.mockResolvedValue({
      $metadata: { httpStatusCode: 200, requestId: "tag-req-role" },
    });
    const desired: Record<string, unknown> = {};
    await ensureSshIamProfile(
      baseState({ runId: "abcdef1234567890" }),
      desired,
    );
    const createRole = mockIamSend.mock.calls[0]![0] as {
      _type: string;
      input: {
        Tags?: Array<{ Key: string; Value: string }>;
      };
    };
    expect(createRole._type).toBe("CreateRoleCommand");
    const tags = createRole.input.Tags;
    expect(tags).toBeInstanceOf(Array);
    const tagMap = new Map((tags ?? []).map((t) => [t.Key, t.Value]));
    expect(tagMap.get("managed-by")).toBe("assignee-ai");
    expect(tagMap.get("assignee-run-id")).toBe("abcdef1234567890");
  });

  it("TagInstanceProfile is invoked with managed-by=assignee-ai + assignee-run-id=<runId>", async () => {
    // BLOCKER #2: CreateInstanceProfile does NOT accept Tags inline,
    // so the implementation must follow it with a TagInstanceProfile
    // call carrying the same two tags. Without this the auto-created
    // profile is invisible to the bulk destroy sweep.
    mockIamSend.mockResolvedValue({
      $metadata: { httpStatusCode: 200, requestId: "tag-req-profile" },
    });
    const desired: Record<string, unknown> = {};
    await ensureSshIamProfile(
      baseState({ runId: "abcdef1234567890" }),
      desired,
    );
    // TagInstanceProfile is the 4th call (index 3), immediately after
    // CreateInstanceProfile and before AddRoleToInstanceProfile.
    const tagProfile = mockIamSend.mock.calls[3]![0] as {
      _type: string;
      input: {
        InstanceProfileName: string;
        Tags: Array<{ Key: string; Value: string }>;
      };
    };
    expect(tagProfile._type).toBe("TagInstanceProfileCommand");
    expect(tagProfile.input.InstanceProfileName).toBe("assignee-ssh-abcdef12");
    const tagMap = new Map(tagProfile.input.Tags.map((t) => [t.Key, t.Value]));
    expect(tagMap.get("managed-by")).toBe("assignee-ai");
    expect(tagMap.get("assignee-run-id")).toBe("abcdef1234567890");
  });

  it("is idempotent: re-runs swallow EntityAlreadyExists on Create*", async () => {
    // First three Create*-style calls hit "already exists"; the AddRole
    // call may also produce LimitExceeded (a profile can hold one role,
    // and we already added it on a prior run). TagInstanceProfile is
    // a no-op on re-tag and returns success.
    const alreadyExists = Object.assign(new Error("Role already exists"), {
      name: "EntityAlreadyExistsException",
    });
    const limitExceeded = Object.assign(
      new Error("Cannot exceed quota for InstanceSessionsPerInstanceProfile"),
      { name: "LimitExceededException" },
    );
    mockIamSend
      // CreateRole
      .mockRejectedValueOnce(alreadyExists)
      // AttachRolePolicy (re-attach is a no-op success)
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } })
      // CreateInstanceProfile
      .mockRejectedValueOnce(alreadyExists)
      // TagInstanceProfile (re-tag is a no-op success on the existing
      // profile — IAM allows updating tags on already-tagged resources)
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } })
      // AddRoleToInstanceProfile
      .mockRejectedValueOnce(limitExceeded);

    const desired: Record<string, unknown> = {};
    const r = await ensureSshIamProfile(baseState(), desired);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.created.roleName).toBe("assignee-ssh-abcdef12");
    expect(r.created.profileName).toBe("assignee-ssh-abcdef12");
    expect(r.created.roleAddedToProfile).toBe(true);
    expect(desired[CfnKey.IAM_INSTANCE_PROFILE]).toBe("assignee-ssh-abcdef12");
  });

  it("tolerates NoSuchEntity on TagInstanceProfile (race window)", async () => {
    // If a parallel destroy raced and removed the just-created profile
    // between Step 3 and Step 4, TagInstanceProfile may return
    // NoSuchEntity. The flow still proceeds to AddRoleToInstanceProfile
    // (which would then surface its own error) — TagInstanceProfile is
    // best-effort because the role IS still tagged via CreateRole.
    const noSuchEntity = Object.assign(new Error("Profile vanished"), {
      name: "NoSuchEntityException",
    });
    mockIamSend
      // CreateRole
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } })
      // AttachRolePolicy
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } })
      // CreateInstanceProfile
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } })
      // TagInstanceProfile — race
      .mockRejectedValueOnce(noSuchEntity)
      // AddRoleToInstanceProfile
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });
    const desired: Record<string, unknown> = {};
    const r = await ensureSshIamProfile(baseState(), desired);
    expect(r.ok).toBe(true);
  });

  it("returns ok:false with FAILED partial when AccessDenied is thrown", async () => {
    const accessDenied = Object.assign(
      new Error(
        "User: arn:aws:iam::123456789012:user/op is not authorized to perform: iam:CreateRole",
      ),
      { name: "AccessDeniedException" },
    );
    mockIamSend.mockRejectedValueOnce(accessDenied);

    const desired: Record<string, unknown> = {};
    const r = await ensureSshIamProfile(baseState(), desired);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected not ok");
    expect(r.partial.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(r.partial.errorMessage).toContain("SSH-bundle IAM");
    expect(r.partial.errorMessage).toContain("iam:CreateRole");
    // Nothing got attached because Step 1 failed.
    expect(r.created.roleName).toBeUndefined();
    expect(r.created.profileName).toBeUndefined();
    expect(desired[CfnKey.IAM_INSTANCE_PROFILE]).toBeUndefined();
  });

  it("returns ok:false but partial-creation tracker is populated when AddRoleToInstanceProfile fails with non-acceptable error", async () => {
    // Steps 1-4 succeed (CreateRole, AttachRolePolicy,
    // CreateInstanceProfile, TagInstanceProfile); Step 5 (the AddRole
    // call) throws a non-acceptable error.
    mockIamSend
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } })
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } })
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } })
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } })
      .mockRejectedValueOnce(
        Object.assign(new Error("Throttling"), {
          name: "ThrottlingException",
        }),
      );

    const desired: Record<string, unknown> = {};
    const r = await ensureSshIamProfile(baseState(), desired);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected not ok");
    // Cleanup tracker MUST capture the partially-created artifacts so the
    // caller can tear them down.
    expect(r.created.roleName).toBe("assignee-ssh-abcdef12");
    expect(r.created.profileName).toBe("assignee-ssh-abcdef12");
    expect(r.created.attachedPolicyArn).toBe(
      "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    );
    expect(r.created.roleAddedToProfile).toBe(false);
    // desiredState was NOT mutated because Step 5 didn't run.
    expect(desired[CfnKey.IAM_INSTANCE_PROFILE]).toBeUndefined();
  });

  it("uses 'default' suffix when runId is empty", async () => {
    mockIamSend.mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
    });
    const desired: Record<string, unknown> = {};
    const r = await ensureSshIamProfile(baseState({ runId: "" }), desired);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.created.profileName).toBe("assignee-ssh-default");
  });

  it("matches userIntent case-insensitively (SSH, Ssh, etc.)", async () => {
    mockIamSend.mockResolvedValue({
      $metadata: { httpStatusCode: 200 },
    });
    const desired: Record<string, unknown> = {};
    const r = await ensureSshIamProfile(
      baseState({ userIntent: "Create EC2 with SSH access" }),
      desired,
    );
    expect(r.ok).toBe(true);
    expect(mockIamSend).toHaveBeenCalled();
  });

  it("does NOT match when 'ssh' is a substring (e.g. 'splash')", async () => {
    const desired: Record<string, unknown> = {};
    const r = await ensureSshIamProfile(
      baseState({ userIntent: "Create a splashscreen instance" }),
      desired,
    );
    expect(r.ok).toBe(true);
    expect(mockIamSend).not.toHaveBeenCalled();
  });
});
