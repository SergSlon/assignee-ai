/**
 * Tests for sdk-direct IAM Role fallback (W5-04).
 * All AWS SDK calls are mocked — no real AWS interaction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createIamRoleSdkDirect,
  SDK_DIRECT_COMPLETE_TOKEN,
} from "./iam-role.js";

vi.mock("@aws-sdk/client-iam", () => {
  const sendMock = vi.fn().mockResolvedValue({});
  const IAMClient = vi.fn().mockImplementation(() => ({ send: sendMock }));
  const CreateRoleCommand = vi.fn().mockImplementation((input) => ({ input }));
  return { IAMClient, CreateRoleCommand };
});

vi.mock("../../config/aws-credentials.js", () => ({
  requireAssigneeCredentials: vi.fn().mockReturnValue({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  }),
}));

const TRUST_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
});

describe("createIamRoleSdkDirect", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // vi.clearAllMocks() resets mockReturnValue/mockImplementation, so
    // re-apply the requireAssigneeCredentials() return-value contract AND the
    // IAMClient send-mock for every test.
    const { requireAssigneeCredentials } =
      await import("../../config/aws-credentials.js");
    vi.mocked(requireAssigneeCredentials).mockReturnValue({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });
    const { IAMClient } = await import("@aws-sdk/client-iam");
    vi.mocked(IAMClient).mockImplementation(
      () => ({ send: vi.fn().mockResolvedValue({}) }) as never,
    );
  });

  it("creates a role and returns SDK_DIRECT_COMPLETE_TOKEN + role name", async () => {
    const result = await createIamRoleSdkDirect(
      JSON.stringify({
        RoleName: "my-lambda-role",
        AssumeRolePolicyDocument: TRUST_POLICY,
      }),
      "us-gov-east-1",
    );
    expect(result.requestToken).toBe(SDK_DIRECT_COMPLETE_TOKEN);
    expect(result.identifier).toBe("my-lambda-role");
  });

  it("accepts AssumeRolePolicyDocument as an object (CCAPI shape)", async () => {
    const trustObj = JSON.parse(TRUST_POLICY) as unknown;
    const result = await createIamRoleSdkDirect(
      JSON.stringify({
        RoleName: "obj-policy-role",
        AssumeRolePolicyDocument: trustObj,
      }),
      "us-iso-east-1",
    );
    expect(result.identifier).toBe("obj-policy-role");
  });

  it("passes optional Description when present", async () => {
    const { CreateRoleCommand } = await import("@aws-sdk/client-iam");
    await createIamRoleSdkDirect(
      JSON.stringify({
        RoleName: "described-role",
        AssumeRolePolicyDocument: TRUST_POLICY,
        Description: "A test role",
      }),
      "eu-isoe-west-1",
    );
    const callArg = vi.mocked(CreateRoleCommand).mock
      .calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(callArg["Description"]).toBe("A test role");
  });

  it("throws an actionable error when RoleName is missing", async () => {
    await expect(
      createIamRoleSdkDirect(
        JSON.stringify({ AssumeRolePolicyDocument: TRUST_POLICY }),
        "us-east-1",
      ),
    ).rejects.toThrow(/"RoleName" is required/);
  });

  it("throws an actionable error when AssumeRolePolicyDocument is missing", async () => {
    await expect(
      createIamRoleSdkDirect(
        JSON.stringify({ RoleName: "no-trust-role" }),
        "us-east-1",
      ),
    ).rejects.toThrow(/"AssumeRolePolicyDocument" is required/);
  });

  it("throws an actionable error when desiredState is invalid JSON", async () => {
    await expect(
      createIamRoleSdkDirect("not-json", "us-east-1"),
    ).rejects.toThrow(/not valid JSON/);
  });
});
