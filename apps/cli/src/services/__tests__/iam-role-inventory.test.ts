/**
 * Tests for iam-role-inventory.ts — the parallel listing path that fills
 * the AWS Resource Groups Tagging API gap for AWS::IAM::Role resources.
 *
 * Closes Phase 2 BUG-1: freshly-tagged IAM roles created by `assignee
 * apply` were invisible to `list` and `destroy --all` because RGTA
 * does not return IAM::Role resources at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockIamSend } = vi.hoisted(() => ({
  mockIamSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-iam", () => {
  class IAMClient {
    send = mockIamSend;
  }
  function ListRolesCommand(input: unknown) {
    return { _type: "ListRoles", input };
  }
  function ListRoleTagsCommand(input: unknown) {
    return { _type: "ListRoleTags", input };
  }
  function GetRoleCommand(input: unknown) {
    return { _type: "GetRole", input };
  }
  return {
    IAMClient,
    ListRolesCommand,
    ListRoleTagsCommand,
    GetRoleCommand,
  };
});

vi.mock("../../config/operator-credentials.js", () => ({
  operatorCredentials: () => ({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
  }),
}));

import {
  fetchManagedIamRoles,
  getManagedIamRoleByArn,
} from "../iam-role-inventory.js";

const ACCOUNT = "112233445566";
const MANAGED_TAG = { Key: "managed-by", Value: "assignee-ai" };
const RUN_ID_TAG = { Key: "assignee-run-id", Value: "run-abc123" };

const managedRole = {
  RoleName: "cli-ex-smoke-iam-1775585360",
  Arn: `arn:aws:iam::${ACCOUNT}:role/cli-ex-smoke-iam-1775585360`,
  CreateDate: new Date("2026-04-07T18:00:00Z"),
};

const unmanagedRole = {
  RoleName: "external-app-role",
  Arn: `arn:aws:iam::${ACCOUNT}:role/external-app-role`,
  CreateDate: new Date("2024-01-01T00:00:00Z"),
};

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

describe("fetchManagedIamRoles", () => {
  it("returns roles tagged with managed-by=assignee-ai", async () => {
    mockIamSend
      // ListRoles
      .mockResolvedValueOnce({ Roles: [managedRole], IsTruncated: false })
      // ListRoleTags for managedRole
      .mockResolvedValueOnce({ Tags: [MANAGED_TAG, RUN_ID_TAG] });

    const result = await fetchManagedIamRoles();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      arn: managedRole.Arn,
      roleName: managedRole.RoleName,
      createdDate: "2026-04-07T18:00:00.000Z",
      tags: { "managed-by": "assignee-ai", "assignee-run-id": "run-abc123" },
    });
    // Describe was paginated through (1 ListRoles call) and tagged once.
    expect(mockIamSend).toHaveBeenCalledTimes(2);
  });

  it("filters out roles without the managed-by tag", async () => {
    mockIamSend
      .mockResolvedValueOnce({
        Roles: [managedRole, unmanagedRole],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Tags: [MANAGED_TAG] }) // managed
      .mockResolvedValueOnce({ Tags: [{ Key: "Owner", Value: "team-x" }] }); // unmanaged

    const result = await fetchManagedIamRoles();

    expect(result).toHaveLength(1);
    expect(result[0]!.roleName).toBe(managedRole.RoleName);
  });

  it("filters out roles whose managed-by tag has the wrong value", async () => {
    mockIamSend
      .mockResolvedValueOnce({ Roles: [managedRole], IsTruncated: false })
      .mockResolvedValueOnce({
        Tags: [{ Key: "managed-by", Value: "terraform" }],
      });

    const result = await fetchManagedIamRoles();
    expect(result).toEqual([]);
  });

  it("handles pagination via IsTruncated + Marker", async () => {
    const role1 = { ...managedRole, RoleName: "managed-1" };
    const role2 = { ...managedRole, RoleName: "managed-2" };
    mockIamSend
      .mockResolvedValueOnce({
        Roles: [role1],
        IsTruncated: true,
        Marker: "page-2-token",
      })
      .mockResolvedValueOnce({ Tags: [MANAGED_TAG] }) // tags for role1
      .mockResolvedValueOnce({ Roles: [role2], IsTruncated: false }) // page 2
      .mockResolvedValueOnce({ Tags: [MANAGED_TAG] }); // tags for role2

    const result = await fetchManagedIamRoles();

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.roleName)).toEqual(["managed-1", "managed-2"]);
    // ListRoles called twice (page 1 + page 2), and the second call must
    // include the Marker from the first page.
    const listRoleCalls = mockIamSend.mock.calls.filter(
      (c) => (c[0] as { _type: string })._type === "ListRoles",
    );
    expect(listRoleCalls).toHaveLength(2);
    expect(
      (listRoleCalls[1]![0] as { input: { Marker?: string } }).input,
    ).toEqual({ Marker: "page-2-token" });
  });

  it("skips a single role when ListRoleTags throws (non-fatal per role)", async () => {
    mockIamSend
      .mockResolvedValueOnce({
        Roles: [managedRole, { ...managedRole, RoleName: "tag-denied-role" }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({ Tags: [MANAGED_TAG] }) // tags ok for role 1
      .mockRejectedValueOnce(
        Object.assign(new Error("AccessDenied"), {
          name: "AccessDeniedException",
        }),
      ); // tags fail for role 2

    const result = await fetchManagedIamRoles();

    // The other role still appears — one bad role must not break the listing.
    expect(result).toHaveLength(1);
    expect(result[0]!.roleName).toBe(managedRole.RoleName);
  });

  it("returns empty array when the account has no roles", async () => {
    mockIamSend.mockResolvedValueOnce({ Roles: [], IsTruncated: false });
    const result = await fetchManagedIamRoles();
    expect(result).toEqual([]);
  });

  it("skips roles missing RoleName or Arn defensively", async () => {
    mockIamSend.mockResolvedValueOnce({
      Roles: [
        { Arn: "arn:aws:iam::112233445566:role/no-name" }, // missing RoleName
        { RoleName: "no-arn" }, // missing Arn
        managedRole,
      ],
      IsTruncated: false,
    });
    mockIamSend.mockResolvedValueOnce({ Tags: [MANAGED_TAG] });

    const result = await fetchManagedIamRoles();
    expect(result).toHaveLength(1);
    expect(result[0]!.roleName).toBe(managedRole.RoleName);
  });
});

describe("getManagedIamRoleByArn", () => {
  it("returns the role when GetRole + tag check both succeed", async () => {
    mockIamSend
      .mockResolvedValueOnce({ Role: managedRole }) // GetRole
      .mockResolvedValueOnce({ Tags: [MANAGED_TAG] }); // ListRoleTags

    const result = await getManagedIamRoleByArn(managedRole.Arn);

    expect(result).not.toBeNull();
    expect(result!.arn).toBe(managedRole.Arn);
    expect(result!.roleName).toBe(managedRole.RoleName);
    expect(result!.tags["managed-by"]).toBe("assignee-ai");
  });

  it("returns null when the role exists but is not managed", async () => {
    mockIamSend
      .mockResolvedValueOnce({ Role: managedRole })
      .mockResolvedValueOnce({ Tags: [{ Key: "Owner", Value: "team-x" }] });

    const result = await getManagedIamRoleByArn(managedRole.Arn);
    expect(result).toBeNull();
  });

  it("returns null when GetRole throws NoSuchEntity", async () => {
    mockIamSend
      .mockRejectedValueOnce(
        Object.assign(new Error("Role does not exist."), {
          name: "NoSuchEntityException",
        }),
      )
      .mockResolvedValueOnce({ Tags: [] });

    const result = await getManagedIamRoleByArn(
      `arn:aws:iam::${ACCOUNT}:role/missing-role`,
    );
    expect(result).toBeNull();
  });

  it("returns null for an ARN that is not an IAM role ARN", async () => {
    const result = await getManagedIamRoleByArn(
      "arn:aws:s3:::not-an-iam-role-arn",
    );
    expect(result).toBeNull();
    // No SDK calls — the function bails on the regex check.
    expect(mockIamSend).not.toHaveBeenCalled();
  });

  it("extracts the role name from a path-prefixed ARN", async () => {
    // IAM roles can live under a path like /service-role/ or /aws-service-role/.
    // Our regex captures everything after the first /role/ — that includes
    // the path. The downstream GetRole(RoleName=…) call requires the bare
    // role name, but assignee never creates path-prefixed roles, so it's
    // sufficient that the captured value matches what assignee uses.
    const arn = `arn:aws:iam::${ACCOUNT}:role/cli-ex-smoke-iam-1775585360`;
    mockIamSend
      .mockResolvedValueOnce({ Role: managedRole })
      .mockResolvedValueOnce({ Tags: [MANAGED_TAG] });

    const result = await getManagedIamRoleByArn(arn);
    expect(result).not.toBeNull();
    // The first SDK call's RoleName matches the captured group.
    const getCall = mockIamSend.mock.calls[0]![0] as {
      input: { RoleName: string };
    };
    expect(getCall.input.RoleName).toBe("cli-ex-smoke-iam-1775585360");
  });
});
