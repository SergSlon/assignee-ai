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

// Wave 10 P0-2: production code now reads credentials via
// `requireAssigneeCredentials("operator")` from @assignee/core (which
// throws MissingAssigneeCredentialsError when env vars are unset)
// rather than `operatorCredentials()` (which silently returned empty
// strings and let IAMClient fall through to the default AWS credential
// chain). The tests configure the env vars in beforeEach so the real
// credential helper succeeds; one test below explicitly clears the
// env vars to verify the throw-and-catch path.
import {
  fetchManagedIamRoles,
  getManagedIamRoleByArn,
} from "../iam-role-inventory.js";
import { MissingAssigneeCredentialsError } from "@assignee/core";

const ACCOUNT = "210987654321";
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
        { Arn: "arn:aws:iam::210987654321:role/no-name" }, // missing RoleName
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

  // Wave 10 P0-2: when ASSIGNEE_OPERATOR_* env vars are unset the
  // production code MUST throw MissingAssigneeCredentialsError instead
  // of silently constructing an IAMClient that falls through to the
  // default credential chain. Critical: NO IAM SDK call must happen.
  it("throws MissingAssigneeCredentialsError when operator env vars are unset (no SDK call)", async () => {
    delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
    delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];

    await expect(fetchManagedIamRoles()).rejects.toBeInstanceOf(
      MissingAssigneeCredentialsError,
    );
    expect(mockIamSend).not.toHaveBeenCalled();
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

  it("extracts the role name from a non-path-prefixed ARN", async () => {
    const arn = `arn:aws:iam::${ACCOUNT}:role/cli-ex-smoke-iam-1775585360`;
    mockIamSend
      .mockResolvedValueOnce({ Role: managedRole })
      .mockResolvedValueOnce({ Tags: [MANAGED_TAG] });

    const result = await getManagedIamRoleByArn(arn);
    expect(result).not.toBeNull();
    const getCall = mockIamSend.mock.calls[0]![0] as {
      input: { RoleName: string };
    };
    expect(getCall.input.RoleName).toBe("cli-ex-smoke-iam-1775585360");
  });

  // Wave 10 P1-1: the previous test claimed to cover the path-prefix
  // strip but actually used a NON-path-prefixed ARN. Removing the
  // `.split('/').pop()` block would not have failed it. These tests
  // pin the actual Wave 9 fix: a /service-role/ prefixed role passed
  // from the user must have its bare name extracted before being sent
  // to GetRole / ListRoleTags (the IAM API rejects slashes in
  // RoleName parameters).
  it("extracts the bare role name from a path-prefixed ARN (Wave 9 strip)", async () => {
    const pathPrefixedRole = {
      RoleName: "MyServiceRole",
      Arn: `arn:aws:iam::${ACCOUNT}:role/service-role/MyServiceRole`,
      CreateDate: new Date("2026-04-07T18:00:00Z"),
    };
    mockIamSend
      .mockResolvedValueOnce({ Role: pathPrefixedRole })
      .mockResolvedValueOnce({ Tags: [MANAGED_TAG] });

    const result = await getManagedIamRoleByArn(pathPrefixedRole.Arn);
    expect(result).not.toBeNull();
    expect(result?.roleName).toBe("MyServiceRole");

    // Both API calls must receive the BARE name, not the path-prefixed value.
    const getCall = mockIamSend.mock.calls[0]![0] as {
      input: { RoleName: string };
    };
    const tagsCall = mockIamSend.mock.calls[1]![0] as {
      input: { RoleName: string };
    };
    expect(getCall.input.RoleName).toBe("MyServiceRole");
    expect(tagsCall.input.RoleName).toBe("MyServiceRole");
  });

  it("extracts the bare role name from a deeply path-prefixed ARN", async () => {
    const deepRole = {
      RoleName: "MyRole",
      Arn: `arn:aws:iam::${ACCOUNT}:role/aws-service-role/foo.amazonaws.com/MyRole`,
      CreateDate: new Date("2026-04-07T18:00:00Z"),
    };
    mockIamSend
      .mockResolvedValueOnce({ Role: deepRole })
      .mockResolvedValueOnce({ Tags: [MANAGED_TAG] });

    const result = await getManagedIamRoleByArn(deepRole.Arn);
    expect(result).not.toBeNull();
    const getCall = mockIamSend.mock.calls[0]![0] as {
      input: { RoleName: string };
    };
    expect(getCall.input.RoleName).toBe("MyRole");
  });

  it("strips a trailing slash and uses the last non-empty path segment as RoleName", async () => {
    // Edge case from Wave 10 review: previously
    // `'service-role/'.split('/').pop()` returned the empty string,
    // which would have been forwarded to GetRole as an empty RoleName
    // and triggered IAM ValidationError. The fix uses
    // `.filter(s => s.length > 0)` so the trailing slash is dropped
    // and `service-role` becomes the extracted name. That value is a
    // legitimate IAM role name (uncommon, but valid per AWS regex
    // `[\w+=,.@-]+`) — if no role with that name exists, the
    // existing NoSuchEntity path returns null.
    mockIamSend
      .mockResolvedValueOnce({
        Role: {
          RoleName: "service-role",
          Arn: `arn:aws:iam::${ACCOUNT}:role/service-role`,
          CreateDate: new Date("2026-04-07T18:00:00Z"),
        },
      })
      .mockResolvedValueOnce({ Tags: [MANAGED_TAG] });

    const result = await getManagedIamRoleByArn(
      `arn:aws:iam::${ACCOUNT}:role/service-role/`,
    );
    expect(result).not.toBeNull();
    expect(result?.roleName).toBe("service-role");

    // Critical: the bare name (no slash) was sent to GetRole.
    const getCall = mockIamSend.mock.calls[0]![0] as {
      input: { RoleName: string };
    };
    expect(getCall.input.RoleName).toBe("service-role");
    // NOT an empty string (which would have triggered IAM ValidationError).
    expect(getCall.input.RoleName).not.toBe("");
  });

  it("returns null for an all-slash path ARN that strips to nothing", async () => {
    // The other edge: ARN like `.../role///` strips to zero non-empty
    // segments and we return null without making an SDK call.
    const result = await getManagedIamRoleByArn(
      `arn:aws:iam::${ACCOUNT}:role////`,
    );
    expect(result).toBeNull();
    expect(mockIamSend).not.toHaveBeenCalled();
  });

  // Wave 10 P0-1: partition-blind regex would have rejected GovCloud /
  // China role ARNs as "not an IAM role ARN" and returned null even
  // when the role exists. Pin both partitions so a regression to the
  // commercial-only `arn:aws:iam::` regex fails CI.
  it("looks up a GovCloud (aws-us-gov) IAM role by ARN", async () => {
    const govRole = {
      RoleName: "MyGovRole",
      Arn: `arn:aws-us-gov:iam::${ACCOUNT}:role/MyGovRole`,
      CreateDate: new Date("2026-04-07T18:00:00Z"),
    };
    mockIamSend
      .mockResolvedValueOnce({ Role: govRole })
      .mockResolvedValueOnce({ Tags: [MANAGED_TAG] });

    const result = await getManagedIamRoleByArn(govRole.Arn);
    expect(result).not.toBeNull();
    expect(result?.roleName).toBe("MyGovRole");
  });

  it("looks up a China (aws-cn) IAM role by ARN", async () => {
    const cnRole = {
      RoleName: "MyChinaRole",
      Arn: `arn:aws-cn:iam::${ACCOUNT}:role/MyChinaRole`,
      CreateDate: new Date("2026-04-07T18:00:00Z"),
    };
    mockIamSend
      .mockResolvedValueOnce({ Role: cnRole })
      .mockResolvedValueOnce({ Tags: [MANAGED_TAG] });

    const result = await getManagedIamRoleByArn(cnRole.Arn);
    expect(result).not.toBeNull();
    expect(result?.roleName).toBe("MyChinaRole");
  });

  // Wave 10 P0-2: byArn path collapses MissingAssigneeCredentialsError
  // to null (matches the existing NoSuchEntity / network swallow).
  // Critical: NO SDK call must happen.
  it("returns null when operator env vars are unset (no SDK call)", async () => {
    delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
    delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];

    const result = await getManagedIamRoleByArn(
      `arn:aws:iam::${ACCOUNT}:role/cli-ex-smoke-iam-1775585360`,
    );
    expect(result).toBeNull();
    expect(mockIamSend).not.toHaveBeenCalled();
  });

  // Wave 11 P2-1: AccessDenied must surface as a friendly error, not
  // collapse to null. A user with a hand-edited operator policy missing
  // iam:GetRole would otherwise see "role not found" for a role that
  // exists, and waste time chasing a non-existent inventory bug.
  it("throws a friendly error when GetRole returns AccessDeniedException", async () => {
    mockIamSend.mockRejectedValueOnce(
      Object.assign(new Error("not authorized"), {
        name: "AccessDeniedException",
      }),
    );

    await expect(
      getManagedIamRoleByArn(`arn:aws:iam::${ACCOUNT}:role/some-role`),
    ).rejects.toThrow(/iam:GetRole or iam:ListRoleTags/);
  });

  it("still returns null on NoSuchEntityException (the legitimate not-found path)", async () => {
    mockIamSend
      .mockRejectedValueOnce(
        Object.assign(new Error("Role does not exist"), {
          name: "NoSuchEntityException",
        }),
      )
      .mockResolvedValueOnce({ Tags: [] });

    const result = await getManagedIamRoleByArn(
      `arn:aws:iam::${ACCOUNT}:role/genuinely-missing-role`,
    );
    expect(result).toBeNull();
  });
});
