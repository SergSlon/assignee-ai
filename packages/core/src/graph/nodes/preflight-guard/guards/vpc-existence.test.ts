/**
 * Unit tests for `vpc-existence.ts` preflight guard (Epic 92 B-10).
 *
 * The guard is tested end-to-end via the `buildVpcExistenceGuard`
 * factory with a stub EC2 client. Production registration uses the
 * real `@aws-sdk/client-ec2` path and is covered by the `ec2:DescribeVpcs`
 * integration path in smoke tests (outside this file).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildVpcExistenceGuard,
  findVerifiableVpcId,
  REAL_VPC_ID_REGEX,
  type VpcExistenceClient,
} from "./vpc-existence.js";
import type { GuardContext } from "../types.js";
import { EnvVar } from "../../../../constants/env-vars.js";

function ctx(desiredState: Record<string, unknown>): GuardContext {
  return {
    state: {
      userIntent: "Create a subnet",
      runId: "run-test-vpc-existence",
      executionMode: "plan",
      resourceType: "AWS::EC2::Subnet",
      resourceSchema: undefined,
      desiredState,
      messages: [],
      preflightPassed: false,
      preflightErrors: [],
      preflightMode: "local",
    } as unknown as GuardContext["state"],
    desiredState,
  };
}

// Realistic DescribeVpcs response shape from the AWS SDK.
// Captured values use test account 210987654321 (non-placeholder per
// feedback_no_real_account_ids_in_repo) and realistic vpc-<hex>.
const REAL_VPC_ID = "vpc-0a1b2c3d4e5f67890";

beforeEach(() => {
  delete process.env[EnvVar.ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS];
});

afterEach(() => {
  delete process.env[EnvVar.ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS];
});

describe("REAL_VPC_ID_REGEX", () => {
  it("matches 17-char modern AWS VPC IDs (default since 2018)", () => {
    expect(REAL_VPC_ID_REGEX.test("vpc-0a1b2c3d4e5f67890")).toBe(true);
  });

  it("matches 8-char legacy AWS VPC IDs (grandfathered accounts)", () => {
    expect(REAL_VPC_ID_REGEX.test("vpc-12345678")).toBe(true);
  });

  it("rejects neither-8-nor-17-char suffixes", () => {
    expect(REAL_VPC_ID_REGEX.test("vpc-123")).toBe(false);
    expect(REAL_VPC_ID_REGEX.test("vpc-123456789")).toBe(false);
    expect(REAL_VPC_ID_REGEX.test("vpc-0a1b2c3d4e5f6789")).toBe(false); // 16
  });

  it("rejects non-hex chars in the suffix", () => {
    expect(REAL_VPC_ID_REGEX.test("vpc-zzzzzzzz")).toBe(false);
    expect(REAL_VPC_ID_REGEX.test("vpc-notahex")).toBe(false);
  });
});

describe("findVerifiableVpcId", () => {
  it("returns the ID when it's a plausible EC2 VpcId string", () => {
    expect(findVerifiableVpcId({ VpcId: REAL_VPC_ID })).toBe(REAL_VPC_ID);
  });

  it("returns the placeholder-shaped VpcId (defers detection to placeholder-resource-id guard)", () => {
    // vpc-existence runs AFTER placeholder-resource-id in the registry,
    // so a placeholder-shaped value either (a) already failed the
    // previous guard, or (b) slipped through an edge path; in either
    // case we still attempt DescribeVpcs since the ID IS
    // vpc-<hex>-shaped and SDK will return NotFound.
    expect(findVerifiableVpcId({ VpcId: "vpc-12345678" })).toBe("vpc-12345678");
  });

  it("returns undefined for absent / empty / non-string VpcId", () => {
    expect(findVerifiableVpcId({})).toBeUndefined();
    expect(findVerifiableVpcId({ VpcId: "" })).toBeUndefined();
    expect(findVerifiableVpcId({ VpcId: "  " })).toBeUndefined();
    expect(findVerifiableVpcId({ VpcId: 42 })).toBeUndefined();
  });

  it("skips CFN intrinsic refs", () => {
    expect(findVerifiableVpcId({ VpcId: "!Ref MyVpc" })).toBeUndefined();
  });

  it("skips non-EC2-id shapes (ARN, arbitrary tokens)", () => {
    expect(
      findVerifiableVpcId({
        VpcId: "arn:aws:ec2:us-east-1:210987654321:vpc/vpc-0a1b2c3d4e5f67890",
      }),
    ).toBeUndefined();
    expect(findVerifiableVpcId({ VpcId: "some-token" })).toBeUndefined();
  });

  it("skips malformed IDs that would only be rejected by AWS (test fixtures, typos)", () => {
    // `vpc-123` is a common test fixture — not a real AWS shape
    // (AWS IDs are 8-char legacy or 17-char modern hex). Skipping
    // these avoids hammering DescribeVpcs for obviously non-AWS
    // values.
    expect(findVerifiableVpcId({ VpcId: "vpc-123" })).toBeUndefined();
    expect(findVerifiableVpcId({ VpcId: "vpc-abc" })).toBeUndefined();
    // 9-char suffix is neither legacy 8 nor modern 17
    expect(findVerifiableVpcId({ VpcId: "vpc-123456789" })).toBeUndefined();
  });
});

describe("vpc-existence guard", () => {
  it("skips when desiredState has no VpcId", async () => {
    const factory = vi.fn<() => Promise<VpcExistenceClient>>();
    const guard = buildVpcExistenceGuard({ clientFactory: factory });
    const result = await guard.run(ctx({ CidrBlock: "10.0.0.0/24" }));
    expect(result.kind).toBe("skip");
    expect(factory).not.toHaveBeenCalled();
  });

  it("passes when DescribeVpcs returns the VPC (B-10 happy path)", async () => {
    const describeVpcs = vi.fn().mockResolvedValue({
      // Realistic SDK response shape
      Vpcs: [
        {
          VpcId: REAL_VPC_ID,
          CidrBlock: "10.0.0.0/16",
          State: "available",
          OwnerId: "210987654321",
          IsDefault: false,
        },
      ],
    });
    const destroy = vi.fn();
    const guard = buildVpcExistenceGuard({
      clientFactory: async () => ({ describeVpcs, destroy }),
    });

    const result = await guard.run(
      ctx({ VpcId: REAL_VPC_ID, CidrBlock: "10.0.1.0/24" }),
    );
    expect(result.kind).toBe("pass");
    expect(describeVpcs).toHaveBeenCalledWith({ VpcIds: [REAL_VPC_ID] });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("fails actionably when Vpcs list is empty (soft NotFound)", async () => {
    const describeVpcs = vi.fn().mockResolvedValue({ Vpcs: [] });
    const guard = buildVpcExistenceGuard({
      clientFactory: async () => ({ describeVpcs }),
    });

    // Well-formed 17-char hex shape that passes the pre-filter but is
    // absent in the target account/region (representative of Epic 92
    // B-10 scenario).
    const ABSENT_VPC_ID = "vpc-0deadbeefcafe1234";
    const result = await guard.run(ctx({ VpcId: ABSENT_VPC_ID }));
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.errorMessage).toContain(ABSENT_VPC_ID);
      expect(result.errorMessage).toContain("does not exist");
      expect(result.errorMessage).toContain("--set VpcId=<real-id>");
    }
  });

  it("fails actionably on InvalidVpcID.NotFound (B-10 canonical path)", async () => {
    // Real error shape from @aws-sdk/client-ec2 when the VPC is absent.
    const awsErr = Object.assign(new Error("The vpc ID does not exist"), {
      name: "InvalidVpcID.NotFound",
      $fault: "client",
      $metadata: { httpStatusCode: 400 },
    });
    const describeVpcs = vi.fn().mockRejectedValue(awsErr);
    const guard = buildVpcExistenceGuard({
      clientFactory: async () => ({ describeVpcs }),
    });

    const ABSENT_VPC_ID = "vpc-0deadbeefcafe1234";
    const result = await guard.run(
      ctx({ VpcId: ABSENT_VPC_ID, CidrBlock: "10.0.1.0/24" }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.errorMessage).toContain("does not exist");
      expect(result.errorMessage).toContain("describe-vpcs");
    }
  });

  it("fails actionably on InvalidVpcID.Malformed", async () => {
    const awsErr = Object.assign(new Error("VpcId is malformed"), {
      name: "InvalidVpcID.Malformed",
      $fault: "client",
      $metadata: { httpStatusCode: 400 },
    });
    const describeVpcs = vi.fn().mockRejectedValue(awsErr);
    const guard = buildVpcExistenceGuard({
      clientFactory: async () => ({ describeVpcs }),
    });

    // Not a placeholder shape the placeholder-resource-id guard
    // catches — this exercises the Malformed branch independently.
    const result = await guard.run(
      ctx({ VpcId: "vpc-notarealhex", CidrBlock: "10.0.1.0/24" }),
    );
    // findVerifiableVpcId only accepts [0-9a-fA-F] after the prefix,
    // so this particular string is skipped. Use one that passes the
    // pre-filter but the SDK rejects.
    expect(result.kind).toBe("skip");

    const result2 = await guard.run(
      ctx({
        // hex-looking but malformed length — passes pre-filter, SDK
        // will actually reject this if probed.
        VpcId: "vpc-deadbeef",
        CidrBlock: "10.0.1.0/24",
      }),
    );
    expect(result2.kind).toBe("fail");
    if (result2.kind === "fail") {
      expect(result2.errorMessage).toContain("malformed");
      expect(result2.errorMessage).toContain("vpc-deadbeef");
    }
  });

  it("fail-CLOSED on auth failure (ExpiredToken)", async () => {
    const authErr = Object.assign(
      new Error("The security token included in the request is expired"),
      {
        name: "ExpiredToken",
        $metadata: { httpStatusCode: 403 },
      },
    );
    const describeVpcs = vi.fn().mockRejectedValue(authErr);
    const guard = buildVpcExistenceGuard({
      clientFactory: async () => ({ describeVpcs }),
    });

    const result = await guard.run(ctx({ VpcId: REAL_VPC_ID }));
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.errorMessage).toContain("credentials expired");
      expect(result.errorMessage).toContain("assignee setup");
    }
  });

  it("PASSES on AccessDenied (unverified + WARN, per managed-policy parity)", async () => {
    const accessDeniedErr = Object.assign(
      new Error("User is not authorized to perform: ec2:DescribeVpcs"),
      {
        name: "UnauthorizedOperation",
        $metadata: { httpStatusCode: 403 },
      },
    );
    const describeVpcs = vi.fn().mockRejectedValue(accessDeniedErr);
    const guard = buildVpcExistenceGuard({
      clientFactory: async () => ({ describeVpcs }),
    });

    const result = await guard.run(ctx({ VpcId: REAL_VPC_ID }));
    expect(result.kind).toBe("pass");
  });

  it("retries on throttling then PASSES on success", async () => {
    const throttleErr = Object.assign(new Error("Rate exceeded"), {
      name: "ThrottlingException",
      $metadata: { httpStatusCode: 400 },
    });
    let calls = 0;
    const describeVpcs = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw throttleErr;
      return {
        Vpcs: [{ VpcId: REAL_VPC_ID, State: "available" }],
      };
    });
    const guard = buildVpcExistenceGuard({
      clientFactory: async () => ({ describeVpcs }),
    });
    const result = await guard.run(ctx({ VpcId: REAL_VPC_ID }));
    expect(result.kind).toBe("pass");
    expect(describeVpcs).toHaveBeenCalledTimes(3);
  });

  it("PASSES when throttling exhausts retries (unverified + WARN)", async () => {
    const throttleErr = Object.assign(new Error("Rate exceeded"), {
      name: "ThrottlingException",
      $metadata: { httpStatusCode: 400 },
    });
    const describeVpcs = vi.fn().mockRejectedValue(throttleErr);
    const guard = buildVpcExistenceGuard({
      clientFactory: async () => ({ describeVpcs }),
    });
    const result = await guard.run(ctx({ VpcId: REAL_VPC_ID }));
    expect(result.kind).toBe("pass");
    // 1 initial + 3 retries = 4 attempts
    expect(describeVpcs).toHaveBeenCalledTimes(4);
  });

  it("PASSES on unknown error in default mode (WARN + unverified)", async () => {
    const netErr = new Error("ECONNRESET");
    const describeVpcs = vi.fn().mockRejectedValue(netErr);
    const guard = buildVpcExistenceGuard({
      clientFactory: async () => ({ describeVpcs }),
    });
    const result = await guard.run(ctx({ VpcId: REAL_VPC_ID }));
    expect(result.kind).toBe("pass");
  });

  it("FAILS on unknown error when ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS=1 (strict mode)", async () => {
    process.env[EnvVar.ASSIGNEE_PREFLIGHT_UNKNOWN_BLOCKS] = "1";
    const netErr = new Error("ECONNRESET");
    const describeVpcs = vi.fn().mockRejectedValue(netErr);
    const guard = buildVpcExistenceGuard({
      clientFactory: async () => ({ describeVpcs }),
    });
    const result = await guard.run(ctx({ VpcId: REAL_VPC_ID }));
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.errorMessage).toContain("Strict mode");
    }
  });

  it("passes when client factory itself fails non-auth-related (WARN + unverified)", async () => {
    const guard = buildVpcExistenceGuard({
      clientFactory: async () => {
        throw new Error("bootstrap config missing");
      },
    });
    const result = await guard.run(ctx({ VpcId: REAL_VPC_ID }));
    expect(result.kind).toBe("pass");
  });

  it("fails-closed when client factory fails due to auth", async () => {
    const authErr = Object.assign(new Error("creds expired"), {
      name: "ExpiredToken",
    });
    const guard = buildVpcExistenceGuard({
      clientFactory: async () => {
        throw authErr;
      },
    });
    const result = await guard.run(ctx({ VpcId: REAL_VPC_ID }));
    expect(result.kind).toBe("fail");
    if (result.kind === "fail") {
      expect(result.errorMessage).toContain("credentials expired");
    }
  });

  it("destroys the client even when DescribeVpcs throws", async () => {
    const awsErr = Object.assign(new Error("not found"), {
      name: "InvalidVpcID.NotFound",
    });
    const describeVpcs = vi.fn().mockRejectedValue(awsErr);
    const destroy = vi.fn();
    const guard = buildVpcExistenceGuard({
      clientFactory: async () => ({ describeVpcs, destroy }),
    });

    await guard.run(ctx({ VpcId: REAL_VPC_ID }));
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
