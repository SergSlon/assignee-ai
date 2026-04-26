/**
 * Tests for sdk-direct EC2 VPC fallback (W5-04).
 * All AWS SDK calls are mocked — no real AWS interaction.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEc2VpcSdkDirect, SDK_DIRECT_COMPLETE_TOKEN } from "./ec2-vpc.js";

// vi.mock factories are hoisted to the top of the file by vitest, so any
// constants they reference must come from vi.hoisted() to be initialized
// in time. Plain top-level constants are still in TDZ when the factory runs.
const { MOCK_VPC_ID } = vi.hoisted(() => ({
  MOCK_VPC_ID: "vpc-0a1b2c3d4e5f6a7b8",
}));

vi.mock("@aws-sdk/client-ec2", () => {
  const sendMock = vi.fn().mockResolvedValue({ Vpc: { VpcId: MOCK_VPC_ID } });
  const EC2Client = vi.fn().mockImplementation(() => ({ send: sendMock }));
  const CreateVpcCommand = vi.fn().mockImplementation((input) => ({ input }));
  return { EC2Client, CreateVpcCommand };
});

vi.mock("../../config/aws-credentials.js", () => ({
  requireAssigneeCredentials: vi.fn().mockReturnValue({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  }),
}));

describe("createEc2VpcSdkDirect", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-apply mocks after clearAllMocks resets return values + implementations.
    const { requireAssigneeCredentials } =
      await import("../../config/aws-credentials.js");
    vi.mocked(requireAssigneeCredentials).mockReturnValue({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });
    const { EC2Client } = await import("@aws-sdk/client-ec2");
    vi.mocked(EC2Client).mockImplementation(
      () =>
        ({
          send: vi.fn().mockResolvedValue({ Vpc: { VpcId: MOCK_VPC_ID } }),
        }) as never,
    );
  });

  it("creates a VPC and returns SDK_DIRECT_COMPLETE_TOKEN + VPC ID", async () => {
    const result = await createEc2VpcSdkDirect(
      JSON.stringify({ CidrBlock: "10.0.0.0/16" }),
      "eu-central-1",
    );
    expect(result.requestToken).toBe(SDK_DIRECT_COMPLETE_TOKEN);
    expect(result.identifier).toBe(MOCK_VPC_ID);
  });

  it("passes InstanceTenancy when specified", async () => {
    const { CreateVpcCommand } = await import("@aws-sdk/client-ec2");
    await createEc2VpcSdkDirect(
      JSON.stringify({
        CidrBlock: "10.1.0.0/16",
        InstanceTenancy: "dedicated",
      }),
      "us-gov-west-1",
    );
    const callArg = vi.mocked(CreateVpcCommand).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArg["InstanceTenancy"]).toBe("dedicated");
  });

  it("defaults InstanceTenancy to 'default' when not specified", async () => {
    const { CreateVpcCommand } = await import("@aws-sdk/client-ec2");
    await createEc2VpcSdkDirect(
      JSON.stringify({ CidrBlock: "10.2.0.0/16" }),
      "eu-isoe-west-1",
    );
    const callArg = vi.mocked(CreateVpcCommand).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArg["InstanceTenancy"]).toBe("default");
  });

  it("throws an actionable error when CidrBlock is missing", async () => {
    await expect(
      createEc2VpcSdkDirect(
        JSON.stringify({ SomeOtherProp: "value" }),
        "us-east-1",
      ),
    ).rejects.toThrow(/"CidrBlock" is required/);
  });

  it("throws an actionable error when desiredState is invalid JSON", async () => {
    await expect(
      createEc2VpcSdkDirect("not-json", "us-east-1"),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("throws an actionable error when AWS returns no VpcId", async () => {
    const { EC2Client } = await import("@aws-sdk/client-ec2");
    vi.mocked(EC2Client).mockImplementationOnce(
      () => ({ send: vi.fn().mockResolvedValue({ Vpc: {} }) }) as never,
    );
    await expect(
      createEc2VpcSdkDirect(
        JSON.stringify({ CidrBlock: "10.3.0.0/16" }),
        "us-east-1",
      ),
    ).rejects.toThrow(/no VpcId/);
  });
});
