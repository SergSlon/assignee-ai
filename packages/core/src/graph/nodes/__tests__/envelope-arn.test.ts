/**
 * Unit coverage for `buildApplyEnvelopeArn` — the apply-envelope
 * `arn` + `primaryIdentifier` projection that closes Epic 97 A-01
 * (Lambda compound bare-identifier) and B-01 (Route/SRTA/VPCGW bare
 * identifier). The helper is the single chokepoint both the CLI
 * orchestrator and the MCP apply-plan tool call, so parity of the
 * envelope shape across packages depends on this module.
 *
 * Test-data discipline: every resource-type / identifier pair here is
 * a realistic CCAPI shape pulled from live probes (E2E runs against
 * `dogfood-*` resources in us-east-1). Test account ID is `210987654321`
 * per `feedback_no_real_account_ids_in_repo`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockResolveResourceArn = vi.hoisted(() =>
  vi.fn<
    (args: {
      resourceType: string;
      identifier: string | undefined;
      region?: string;
    }) => Promise<string | undefined>
  >(),
);

vi.mock("@/utils/resolve-arn.js", () => ({
  resolveResourceArn: (args: {
    resourceType: string;
    identifier: string | undefined;
    region?: string;
  }) => mockResolveResourceArn(args),
  getOperatorCallerArn: vi.fn(),
  getOperatorAccountId: vi.fn(),
  resetAccountIdCache: vi.fn(),
}));

import { buildApplyEnvelopeArn } from "../result-formatter/envelope-arn.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildApplyEnvelopeArn — ARN-addressable types", () => {
  it("synthesises full Lambda ARN from bare function name (A-01 closure)", async () => {
    mockResolveResourceArn.mockResolvedValueOnce(
      "arn:aws:lambda:us-east-1:210987654321:function:dogfood-e97-a-fn-1776953643",
    );
    const result = await buildApplyEnvelopeArn(
      "AWS::Lambda::Function",
      "dogfood-e97-a-fn-1776953643",
    );
    expect(result.arn).toBe(
      "arn:aws:lambda:us-east-1:210987654321:function:dogfood-e97-a-fn-1776953643",
    );
    expect(result.primaryIdentifier).toBeNull();
    expect(mockResolveResourceArn).toHaveBeenCalledWith({
      resourceType: "AWS::Lambda::Function",
      identifier: "dogfood-e97-a-fn-1776953643",
    });
  });

  it("synthesises full S3 bucket ARN (regression baseline — S3 was already correct)", async () => {
    mockResolveResourceArn.mockResolvedValueOnce(
      "arn:aws:s3:::dogfood-e97-a-bucket-1776953600",
    );
    const result = await buildApplyEnvelopeArn(
      "AWS::S3::Bucket",
      "dogfood-e97-a-bucket-1776953600",
    );
    expect(result.arn).toBe("arn:aws:s3:::dogfood-e97-a-bucket-1776953600");
    expect(result.primaryIdentifier).toBeNull();
  });

  it("synthesises full DDB table ARN", async () => {
    mockResolveResourceArn.mockResolvedValueOnce(
      "arn:aws:dynamodb:us-east-1:210987654321:table/dogfood-e97-a-ddb-1776953700",
    );
    const result = await buildApplyEnvelopeArn(
      "AWS::DynamoDB::Table",
      "dogfood-e97-a-ddb-1776953700",
    );
    expect(result.arn).toBe(
      "arn:aws:dynamodb:us-east-1:210987654321:table/dogfood-e97-a-ddb-1776953700",
    );
    expect(result.primaryIdentifier).toBeNull();
  });

  it("preserves an already-ARN identifier verbatim (idempotent short-circuit)", async () => {
    // resolveResourceArn's internal `isArn()` short-circuit means the
    // helper returns the input unchanged. We mock it here to mirror
    // the contract surface.
    mockResolveResourceArn.mockResolvedValueOnce(
      "arn:aws:iam::210987654321:role/assignee-iam-execution-role-abc",
    );
    const result = await buildApplyEnvelopeArn(
      "AWS::IAM::Role",
      "arn:aws:iam::210987654321:role/assignee-iam-execution-role-abc",
    );
    expect(result.arn).toBe(
      "arn:aws:iam::210987654321:role/assignee-iam-execution-role-abc",
    );
    expect(result.primaryIdentifier).toBeNull();
  });

  it("falls back to the bare identifier when STS is unavailable", async () => {
    // Simulate CI with no AWS creds: resolveResourceArn returns
    // undefined so the envelope still carries a destroy-able handle.
    mockResolveResourceArn.mockResolvedValueOnce(undefined);
    const result = await buildApplyEnvelopeArn(
      "AWS::Lambda::Function",
      "dogfood-e97-a-fn-no-creds",
    );
    expect(result.arn).toBe("dogfood-e97-a-fn-no-creds");
    expect(result.primaryIdentifier).toBeNull();
  });
});

describe("buildApplyEnvelopeArn — non-taggable CFN constructs (B-01 closure)", () => {
  it("AWS::EC2::Route → arn:null + primaryIdentifier carrying rtb|cidr", async () => {
    const result = await buildApplyEnvelopeArn(
      "AWS::EC2::Route",
      "rtb-016d13dcc6076462d|0.0.0.0/0",
    );
    expect(result.arn).toBeNull();
    expect(result.primaryIdentifier).toBe("rtb-016d13dcc6076462d|0.0.0.0/0");
    // Resolver MUST NOT be called for non-taggable types — they have
    // no standalone AWS ARN, so an STS lookup is wasted work.
    expect(mockResolveResourceArn).not.toHaveBeenCalled();
  });

  it("AWS::EC2::SubnetRouteTableAssociation → arn:null + primaryIdentifier rtbassoc-XXX", async () => {
    const result = await buildApplyEnvelopeArn(
      "AWS::EC2::SubnetRouteTableAssociation",
      "rtbassoc-0b2bb97aacd090704",
    );
    expect(result.arn).toBeNull();
    expect(result.primaryIdentifier).toBe("rtbassoc-0b2bb97aacd090704");
    expect(mockResolveResourceArn).not.toHaveBeenCalled();
  });

  it("AWS::EC2::VPCGatewayAttachment → arn:null + primaryIdentifier igw|vpc", async () => {
    const result = await buildApplyEnvelopeArn(
      "AWS::EC2::VPCGatewayAttachment",
      "igw-0abc12345|vpc-0def67890",
    );
    expect(result.arn).toBeNull();
    expect(result.primaryIdentifier).toBe("igw-0abc12345|vpc-0def67890");
    expect(mockResolveResourceArn).not.toHaveBeenCalled();
  });
});

describe("buildApplyEnvelopeArn — empty / missing inputs", () => {
  it("returns {null,null} when identifier is undefined", async () => {
    const result = await buildApplyEnvelopeArn(
      "AWS::Lambda::Function",
      undefined,
    );
    expect(result.arn).toBeNull();
    expect(result.primaryIdentifier).toBeNull();
    expect(mockResolveResourceArn).not.toHaveBeenCalled();
  });

  it("returns {null,null} when identifier is the empty string", async () => {
    const result = await buildApplyEnvelopeArn("AWS::Lambda::Function", "");
    expect(result.arn).toBeNull();
    expect(result.primaryIdentifier).toBeNull();
    expect(mockResolveResourceArn).not.toHaveBeenCalled();
  });

  it("returns {null,null} when resourceType is undefined (early-exit path)", async () => {
    const result = await buildApplyEnvelopeArn(undefined, "some-id");
    expect(result.arn).toBeNull();
    expect(result.primaryIdentifier).toBeNull();
    expect(mockResolveResourceArn).not.toHaveBeenCalled();
  });
});
