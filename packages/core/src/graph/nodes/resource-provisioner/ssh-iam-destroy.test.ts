/**
 * Tests for `ssh-iam-destroy.ts` — the post-destroy IAM cleanup hook.
 *
 * Covers:
 *   - Deterministic name computation (parity with ssh-iam.ts)
 *   - Happy path: all 4 IAM calls fire in correct order
 *   - NoSuchEntity at each step is swallowed → still counts as removed
 *   - DeleteRole conflict (other policies attached) surfaces an actionable
 *     warning instead of throwing
 *   - Generic IAM errors are recorded in warnings + logged, never thrown
 *   - `maybeDestroySshBundleIamForArn` no-ops cleanly when:
 *       (a) resourceType is not EC2::Instance
 *       (b) provision record is missing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockIamSend, mockReadProvisionRecord } = vi.hoisted(() => ({
  mockIamSend: vi.fn(),
  mockReadProvisionRecord: vi.fn(),
}));

function makeCommandFactory<T extends string>(
  _type: T,
): (input: unknown) => { _type: T; input: unknown } {
  return function CommandFactory(input: unknown) {
    return { _type, input };
  };
}

vi.mock("@aws-sdk/client-iam", () => {
  class IAMClient {
    send = mockIamSend;
    destroy = vi.fn();
  }
  return {
    IAMClient,
    RemoveRoleFromInstanceProfileCommand: makeCommandFactory(
      "RemoveRoleFromInstanceProfileCommand",
    ),
    DeleteInstanceProfileCommand: makeCommandFactory(
      "DeleteInstanceProfileCommand",
    ),
    DetachRolePolicyCommand: makeCommandFactory("DetachRolePolicyCommand"),
    DeleteRoleCommand: makeCommandFactory("DeleteRoleCommand"),
  };
});

vi.mock("@/config/aws-credentials.js", () => ({
  requireAssigneeCredentials: () => ({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  }),
}));

vi.mock("@/services/memory.js", () => ({
  defaultMemoryService: {
    readProvisionRecord: mockReadProvisionRecord,
  },
}));

import {
  computeSshBundleIamNames,
  destroySshBundleIam,
  maybeDestroySshBundleIamForArn,
} from "./ssh-iam-destroy.js";

// ── Realistic fixtures ───────────────────────────────────────────────────────

const RUN_ID = "bf7a3c9e-2f81-4d12-9c3a-1e8b5f7d9a04";
const ROLE_NAME = "assignee-ssh-bf7a3c9e";
const PROFILE_NAME = ROLE_NAME;
const REGION = "us-east-1";
const EC2_ARN = `arn:aws:ec2:us-east-1:123456789012:instance/i-0abc123def4567890`;
const EXPECTED_POLICY_ARN =
  "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore";

function commandTypes(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map((c) => (c[0] as { _type: string })._type);
}

function namedError(name: string, message = name): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

beforeEach(() => {
  mockIamSend.mockReset();
  mockReadProvisionRecord.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("computeSshBundleIamNames", () => {
  it("derives the role + profile name from the first 8 chars of runId", () => {
    expect(computeSshBundleIamNames(RUN_ID)).toEqual({
      roleName: ROLE_NAME,
      profileName: PROFILE_NAME,
    });
  });

  it("falls back to 'default' suffix when runId is empty (defensive)", () => {
    expect(computeSshBundleIamNames("")).toEqual({
      roleName: "assignee-ssh-default",
      profileName: "assignee-ssh-default",
    });
  });

  it("falls back to 'default' suffix when runId is undefined", () => {
    expect(computeSshBundleIamNames(undefined)).toEqual({
      roleName: "assignee-ssh-default",
      profileName: "assignee-ssh-default",
    });
  });
});

describe("destroySshBundleIam — happy path", () => {
  it("issues all 4 IAM calls in the required order", async () => {
    mockIamSend.mockResolvedValue({});

    const result = await destroySshBundleIam(RUN_ID, REGION);

    expect(commandTypes(mockIamSend)).toEqual([
      "RemoveRoleFromInstanceProfileCommand",
      "DeleteInstanceProfileCommand",
      "DetachRolePolicyCommand",
      "DeleteRoleCommand",
    ]);
    expect(result).toEqual({
      roleName: ROLE_NAME,
      profileName: PROFILE_NAME,
      roleRemoved: true,
      profileRemoved: true,
      warnings: [],
    });
  });

  it("targets the correct role + profile + managed-policy ARN", async () => {
    mockIamSend.mockResolvedValue({});

    await destroySshBundleIam(RUN_ID, REGION);

    expect(mockIamSend.mock.calls[0]![0]).toMatchObject({
      _type: "RemoveRoleFromInstanceProfileCommand",
      input: { InstanceProfileName: PROFILE_NAME, RoleName: ROLE_NAME },
    });
    expect(mockIamSend.mock.calls[1]![0]).toMatchObject({
      _type: "DeleteInstanceProfileCommand",
      input: { InstanceProfileName: PROFILE_NAME },
    });
    expect(mockIamSend.mock.calls[2]![0]).toMatchObject({
      _type: "DetachRolePolicyCommand",
      input: { RoleName: ROLE_NAME, PolicyArn: EXPECTED_POLICY_ARN },
    });
    expect(mockIamSend.mock.calls[3]![0]).toMatchObject({
      _type: "DeleteRoleCommand",
      input: { RoleName: ROLE_NAME },
    });
  });

  it("uses the partition-aware managed-policy ARN for GovCloud", async () => {
    mockIamSend.mockResolvedValue({});

    await destroySshBundleIam(RUN_ID, "us-gov-west-1");

    expect(mockIamSend.mock.calls[2]![0]).toMatchObject({
      _type: "DetachRolePolicyCommand",
      input: {
        RoleName: ROLE_NAME,
        PolicyArn:
          "arn:aws-us-gov:iam::aws:policy/AmazonSSMManagedInstanceCore",
      },
    });
  });
});

describe("destroySshBundleIam — NoSuchEntity tolerance", () => {
  it("treats RemoveRoleFromInstanceProfile NoSuchEntity as success (no warning)", async () => {
    mockIamSend
      .mockRejectedValueOnce(namedError("NoSuchEntityException"))
      .mockResolvedValueOnce({}) // DeleteInstanceProfile
      .mockResolvedValueOnce({}) // DetachRolePolicy
      .mockResolvedValueOnce({}); // DeleteRole

    const result = await destroySshBundleIam(RUN_ID, REGION);

    expect(result.warnings).toEqual([]);
    expect(result.roleRemoved).toBe(true);
    expect(result.profileRemoved).toBe(true);
  });

  it("treats DeleteInstanceProfile NoSuchEntity as removed=true", async () => {
    mockIamSend
      .mockResolvedValueOnce({}) // RemoveRoleFromInstanceProfile
      .mockRejectedValueOnce(namedError("NoSuchEntityException")) // DeleteInstanceProfile
      .mockResolvedValueOnce({}) // DetachRolePolicy
      .mockResolvedValueOnce({}); // DeleteRole

    const result = await destroySshBundleIam(RUN_ID, REGION);

    expect(result.profileRemoved).toBe(true);
    expect(result.roleRemoved).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("treats DetachRolePolicy NoSuchEntity as success (no warning)", async () => {
    mockIamSend
      .mockResolvedValueOnce({}) // RemoveRoleFromInstanceProfile
      .mockResolvedValueOnce({}) // DeleteInstanceProfile
      .mockRejectedValueOnce(namedError("NoSuchEntityException")) // DetachRolePolicy
      .mockResolvedValueOnce({}); // DeleteRole

    const result = await destroySshBundleIam(RUN_ID, REGION);

    expect(result.warnings).toEqual([]);
    expect(result.roleRemoved).toBe(true);
  });

  it("treats DeleteRole NoSuchEntity as roleRemoved=true", async () => {
    mockIamSend
      .mockResolvedValueOnce({}) // RemoveRoleFromInstanceProfile
      .mockResolvedValueOnce({}) // DeleteInstanceProfile
      .mockResolvedValueOnce({}) // DetachRolePolicy
      .mockRejectedValueOnce(namedError("NoSuchEntityException")); // DeleteRole

    const result = await destroySshBundleIam(RUN_ID, REGION);

    expect(result.roleRemoved).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("accepts the bare `NoSuchEntity` name (some SDKs strip Exception suffix)", async () => {
    mockIamSend
      .mockResolvedValueOnce({}) // RemoveRoleFromInstanceProfile
      .mockRejectedValueOnce(namedError("NoSuchEntity")) // DeleteInstanceProfile
      .mockResolvedValueOnce({}) // DetachRolePolicy
      .mockRejectedValueOnce(namedError("NoSuchEntity")); // DeleteRole

    const result = await destroySshBundleIam(RUN_ID, REGION);

    expect(result.profileRemoved).toBe(true);
    expect(result.roleRemoved).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

describe("destroySshBundleIam — non-fatal errors", () => {
  it("surfaces an actionable hint when DeleteRole hits DeleteConflict (extra policies attached)", async () => {
    mockIamSend
      .mockResolvedValueOnce({}) // RemoveRoleFromInstanceProfile
      .mockResolvedValueOnce({}) // DeleteInstanceProfile
      .mockResolvedValueOnce({}) // DetachRolePolicy
      .mockRejectedValueOnce(namedError("DeleteConflictException"));

    const result = await destroySshBundleIam(RUN_ID, REGION);

    expect(result.profileRemoved).toBe(true);
    expect(result.roleRemoved).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("DeleteRole conflict");
    expect(result.warnings[0]).toContain(ROLE_NAME);
    expect(result.warnings[0]).toContain("aws iam delete-role");
  });

  it("records a warning when DeleteInstanceProfile fails non-NoSuchEntity (does not throw)", async () => {
    mockIamSend
      .mockResolvedValueOnce({}) // RemoveRoleFromInstanceProfile
      .mockRejectedValueOnce(namedError("AccessDeniedException")) // DeleteInstanceProfile
      .mockResolvedValueOnce({}) // DetachRolePolicy
      .mockResolvedValueOnce({}); // DeleteRole

    const result = await destroySshBundleIam(RUN_ID, REGION);

    expect(result.profileRemoved).toBe(false);
    expect(result.roleRemoved).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("DeleteInstanceProfile failed");
    expect(result.warnings[0]).toContain(PROFILE_NAME);
  });

  it("never throws even when every IAM call fails", async () => {
    mockIamSend.mockRejectedValue(namedError("Throttling"));

    const result = await destroySshBundleIam(RUN_ID, REGION);

    expect(result.profileRemoved).toBe(false);
    expect(result.roleRemoved).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("maybeDestroySshBundleIamForArn", () => {
  it("no-ops when resourceType is not EC2::Instance", async () => {
    const result = await maybeDestroySshBundleIamForArn(
      "arn:aws:s3:::my-bucket",
      "AWS::S3::Bucket",
      REGION,
    );

    expect(result).toBeUndefined();
    expect(mockReadProvisionRecord).not.toHaveBeenCalled();
    expect(mockIamSend).not.toHaveBeenCalled();
  });

  it("no-ops when arn is empty (non-taggable EC2 corner case)", async () => {
    const result = await maybeDestroySshBundleIamForArn(
      "",
      "AWS::EC2::Instance",
      REGION,
    );

    expect(result).toBeUndefined();
    expect(mockReadProvisionRecord).not.toHaveBeenCalled();
    expect(mockIamSend).not.toHaveBeenCalled();
  });

  it("no-ops when no provision record matches the ARN (rotated out / pre-Story-iv apply)", async () => {
    mockReadProvisionRecord.mockResolvedValue(undefined);

    const result = await maybeDestroySshBundleIamForArn(
      EC2_ARN,
      "AWS::EC2::Instance",
      REGION,
    );

    expect(result).toBeUndefined();
    expect(mockReadProvisionRecord).toHaveBeenCalledWith(EC2_ARN);
    expect(mockIamSend).not.toHaveBeenCalled();
  });

  it("looks up the runId via memory service and runs the full IAM teardown", async () => {
    mockReadProvisionRecord.mockResolvedValue({
      runId: RUN_ID,
      resourceType: "AWS::EC2::Instance",
      resourceArn: EC2_ARN,
      region: REGION,
      desiredStateHash: "abc",
      estimatedMonthlyCost: "$8.30/mo",
      timestamp: "2026-05-05T10:00:00.000Z",
    });
    mockIamSend.mockResolvedValue({});

    const result = await maybeDestroySshBundleIamForArn(
      EC2_ARN,
      "AWS::EC2::Instance",
      REGION,
    );

    expect(mockReadProvisionRecord).toHaveBeenCalledWith(EC2_ARN);
    expect(commandTypes(mockIamSend)).toEqual([
      "RemoveRoleFromInstanceProfileCommand",
      "DeleteInstanceProfileCommand",
      "DetachRolePolicyCommand",
      "DeleteRoleCommand",
    ]);
    expect(result?.roleRemoved).toBe(true);
    expect(result?.profileRemoved).toBe(true);
    expect(result?.warnings).toEqual([]);
  });
});
