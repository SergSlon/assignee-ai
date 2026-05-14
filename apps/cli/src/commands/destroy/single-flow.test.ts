/**
 * Tests for the EIP provision-log fallback in single-flow destroy.
 *
 * BUG-5 hotfix: RGTA does not enumerate EIP ARNs (elastic-ip/* prefix).
 * destroy "arn:aws:ec2:…:elastic-ip/eipalloc-xxx" returned
 * DESTROY_TARGET_NOT_FOUND because the provision-log fallback only
 * allowed non-taggable constructs. This file exercises the ARN-keyed
 * fallback path added by the BUG-5 fix.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted stubs ────────────────────────────────────────────────────────────
const {
  mockFindProvisionRecord,
  mockResolveResource,
  mockDestroySingleResource,
  mockMaybeDestroySshBundleIamForArn,
} = vi.hoisted(() => ({
  mockFindProvisionRecord: vi.fn(),
  mockResolveResource: vi.fn(),
  mockDestroySingleResource: vi.fn(),
  mockMaybeDestroySshBundleIamForArn: vi.fn(),
}));

// ── @assignee/core: real isNonTaggableConstruct, stubbed findProvisionRecord ──
vi.mock("@assignee/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@assignee/core")>();
  return {
    ...real,
    findProvisionRecord: (...args: unknown[]) =>
      mockFindProvisionRecord(...args),
    // B6 (Q-H-001): stub appendDestroyedArn to prevent live writes to
    // ~/.assignee/memory.json during unit tests (test-pollution fix).
    appendDestroyedArn: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@assignee/core/graph", () => ({
  maybeDestroySshBundleIamForArn: (...args: unknown[]) =>
    mockMaybeDestroySshBundleIamForArn(...args),
}));

vi.mock("../../services/resource-resolver.js", () => ({
  resolveResource: (...args: unknown[]) => mockResolveResource(...args),
  createTaggingClient: vi.fn().mockReturnValue({}),
  isAmbiguousResolution: (value: unknown): boolean =>
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "ambiguous",
}));

vi.mock("../../services/destroy-service.js", () => ({
  destroySingleResource: (...args: unknown[]) =>
    mockDestroySingleResource(...args),
}));

const { mockGetCostSavingsEstimate } = vi.hoisted(() => ({
  mockGetCostSavingsEstimate: vi.fn().mockResolvedValue("$3.60/mo"),
}));

vi.mock("../../services/billing.js", () => ({
  getCostSavingsEstimate: (...args: unknown[]) =>
    mockGetCostSavingsEstimate(...args),
}));

vi.mock("../../services/mcp-client.js", () => ({
  getBillingMcpToolsAsync: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../utils/display.js", () => ({
  startSpinner: vi.fn(),
  stopSpinner: vi.fn(),
  updateSpinner: vi.fn(),
}));

vi.mock("../../config/aws-credentials.js", () => ({
  tryAssigneeCredentials: vi.fn(() => ({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  })),
}));

vi.mock("@clack/prompts", () => ({
  text: vi.fn(),
  outro: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));

vi.mock("boxen", () => ({ default: (s: string) => s }));
vi.mock("chalk", () => {
  const id = (s: string) => s;
  const ch = Object.assign(id, { bold: Object.assign(id, { bold: id }) });
  return {
    default: { red: ch, green: ch, yellow: ch, cyan: ch, dim: id, bold: id },
  };
});

import { singleDestroyAction } from "./single-flow.js";

const EIP_ARN =
  "arn:aws:ec2:us-east-1:112233445566:elastic-ip/eipalloc-0a4b5c6d7e8f90123";

beforeEach(() => {
  vi.clearAllMocks();
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "test-key";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = "test-secret";
  process.env["AWS_REGION"] = "us-east-1";
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    writable: true,
    configurable: true,
  });
});

describe("singleDestroyAction — EIP provision-log ARN fallback (BUG-5)", () => {
  it("resolves EIP ARN from provision log when RGTA returns null", async () => {
    // RGTA can't find elastic-ip ARNs → resolveResource returns null
    mockResolveResource.mockResolvedValue(null);

    // Provision log has the EIP record keyed by full ARN
    mockFindProvisionRecord.mockResolvedValue({
      keyKind: "arn",
      key: EIP_ARN,
      resourceType: "AWS::EC2::EIP",
      region: "us-east-1",
      createdDate: "2026-04-23T00:00:00Z",
      estimatedMonthlyCost: "$3.60/mo",
      runId: "run-abc123",
    });

    mockDestroySingleResource.mockResolvedValue({
      success: true,
      resourceType: "AWS::EC2::EIP",
      identifier: "eipalloc-0a4b5c6d7e8f90123",
      arn: EIP_ARN,
    });

    // Must not throw DESTROY_TARGET_NOT_FOUND
    await singleDestroyAction(EIP_ARN, { yes: true });

    expect(mockDestroySingleResource).toHaveBeenCalledTimes(1);
    const callArg = mockDestroySingleResource.mock.calls[0]![0] as {
      arn: string;
      resourceType: string;
      identifier: string;
      region: string;
    };
    expect(callArg.arn).toBe(EIP_ARN);
    expect(callArg.resourceType).toBe("AWS::EC2::EIP");
    // identifier must be the bare AllocationId, not the full ARN
    expect(callArg.identifier).toBe("eipalloc-0a4b5c6d7e8f90123");
    expect(callArg.region).toBe("us-east-1");
  });

  it("still throws DESTROY_TARGET_NOT_FOUND when provision log also has no record", async () => {
    mockResolveResource.mockResolvedValue(null);
    mockFindProvisionRecord.mockResolvedValue(null);

    await expect(singleDestroyAction(EIP_ARN, { yes: true })).rejects.toThrow(
      /No managed resource found/,
    );
  });

  it("invokes SSH-bundle IAM cleanup after EC2::Instance destroy (audit H3)", async () => {
    // Pre-demo audit (2026-05-05) H3: when the user destroys an EC2
    // instance that was applied via the SSH bundle, the auto-created
    // `assignee-ssh-<runId-suffix>` IAM role + instance profile must
    // also be torn down so they don't accumulate as orphans across
    // demo iterations. The cleanup is silent best-effort — non-EC2
    // destroys (asserted in the next test) skip the call entirely.
    const EC2_ARN =
      "arn:aws:ec2:us-east-1:112233445566:instance/i-0abc123def4567890";
    mockResolveResource.mockResolvedValue({
      arn: EC2_ARN,
      resourceType: "AWS::EC2::Instance",
      region: "us-east-1",
      tags: { "managed-by": "assignee-ai" },
      identifier: "i-0abc123def4567890",
    });
    mockDestroySingleResource.mockResolvedValue({
      success: true,
      resourceType: "AWS::EC2::Instance",
      identifier: "i-0abc123def4567890",
      arn: EC2_ARN,
    });
    mockMaybeDestroySshBundleIamForArn.mockResolvedValue({
      roleName: "assignee-ssh-bf7a3c9e",
      profileName: "assignee-ssh-bf7a3c9e",
      roleRemoved: true,
      profileRemoved: true,
      warnings: [],
    });

    await singleDestroyAction(EC2_ARN, { yes: true });

    expect(mockDestroySingleResource).toHaveBeenCalledTimes(1);
    expect(mockMaybeDestroySshBundleIamForArn).toHaveBeenCalledTimes(1);
    expect(mockMaybeDestroySshBundleIamForArn).toHaveBeenCalledWith(
      EC2_ARN,
      "AWS::EC2::Instance",
      "us-east-1",
    );
  });

  it("calls SSH-bundle cleanup with the right shape for non-EC2 destroys (cleanup helper no-ops internally)", async () => {
    // The CLI flow always calls `maybeDestroySshBundleIamForArn` after
    // a successful destroy regardless of resource type — the helper
    // itself is responsible for the resourceType !== EC2_INSTANCE
    // short-circuit (asserted in `ssh-iam-destroy.test.ts`). This test
    // only checks that the call was issued with the correct arguments
    // so the contract between single-flow.ts and the helper stays
    // observable from the CLI side.
    const S3_ARN = "arn:aws:s3:::my-bucket-1234567890";
    mockResolveResource.mockResolvedValue({
      arn: S3_ARN,
      resourceType: "AWS::S3::Bucket",
      region: "us-east-1",
      tags: { "managed-by": "assignee-ai" },
      identifier: "my-bucket-1234567890",
    });
    mockDestroySingleResource.mockResolvedValue({
      success: true,
      resourceType: "AWS::S3::Bucket",
      identifier: "my-bucket-1234567890",
      arn: S3_ARN,
    });

    await singleDestroyAction(S3_ARN, { yes: true });

    expect(mockMaybeDestroySshBundleIamForArn).toHaveBeenCalledWith(
      S3_ARN,
      "AWS::S3::Bucket",
      "us-east-1",
    );
  });

  it("does not surface SSH-bundle IAM cleanup failures to the caller (best-effort)", async () => {
    // Audit H3 contract: IAM cleanup failures must NOT fail the destroy
    // command — the EC2 itself was successfully destroyed; surfacing IAM
    // cleanup failures to stderr would confuse the operator about
    // whether the primary destroy worked. The helper is documented to
    // never throw, but defensive: if it ever does, the destroy still
    // succeeds.
    const EC2_ARN =
      "arn:aws:ec2:us-east-1:112233445566:instance/i-0abc123def4567890";
    mockResolveResource.mockResolvedValue({
      arn: EC2_ARN,
      resourceType: "AWS::EC2::Instance",
      region: "us-east-1",
      tags: { "managed-by": "assignee-ai" },
      identifier: "i-0abc123def4567890",
    });
    mockDestroySingleResource.mockResolvedValue({
      success: true,
      resourceType: "AWS::EC2::Instance",
      identifier: "i-0abc123def4567890",
      arn: EC2_ARN,
    });
    mockMaybeDestroySshBundleIamForArn.mockRejectedValue(
      new Error("Unexpected IAM exception"),
    );

    // The destroy command MUST resolve successfully even if the IAM
    // cleanup hook throws — defence-in-depth try/catch in
    // single-flow.ts guarantees the contract at the call site
    // independently of the helper's internal swallow.
    await expect(
      singleDestroyAction(EC2_ARN, { yes: true }),
    ).resolves.toBeUndefined();
    expect(mockMaybeDestroySshBundleIamForArn).toHaveBeenCalledTimes(1);
  });

  it("non-taggable construct fallback path is unaffected (Route)", async () => {
    const ROUTE_ID = "rtb-0a1b2c3d4e5f60708|0.0.0.0/0";
    mockResolveResource.mockResolvedValue(null);
    mockFindProvisionRecord.mockResolvedValue({
      keyKind: "primaryIdentifier",
      key: ROUTE_ID,
      resourceType: "AWS::EC2::Route",
      region: "us-east-1",
      createdDate: "2026-04-23T00:00:00Z",
      estimatedMonthlyCost: "$0.00/mo",
      runId: "run-xyz789",
    });
    mockDestroySingleResource.mockResolvedValue({
      success: true,
      resourceType: "AWS::EC2::Route",
      identifier: ROUTE_ID,
      arn: "",
    });

    await singleDestroyAction(ROUTE_ID, { yes: true });

    expect(mockDestroySingleResource).toHaveBeenCalledTimes(1);
    const callArg = mockDestroySingleResource.mock.calls[0]![0] as {
      arn: string;
      resourceType: string;
      identifier: string;
    };
    expect(callArg.resourceType).toBe("AWS::EC2::Route");
    expect(callArg.identifier).toBe(ROUTE_ID);
    expect(callArg.arn).toBe("");
  });

  // ── DC-1: OAC bare-ID list/destroy mismatch fix ─────────────────────────
  // DF-OAC-LIST-DESTROY-MISMATCH: `assignee list` surfaces OAC by bare CCAPI
  // Id (E3EYXPSYURQIM9) but destroy previously failed with "No managed resource
  // found" because `isNonTaggableConstruct` returned false for OAC.
  // Fix: add OAC + BucketPolicy to NON_TAGGABLE_RESOURCE_TYPES so the
  // provision-log fallback path in single-flow.ts:89 accepts them.

  it("Var A: bare OAC Id resolves and triggers CCAPI delete", async () => {
    // RGTA doesn't return OAC (not taggable) → resolveResource returns null.
    mockResolveResource.mockResolvedValue(null);
    mockFindProvisionRecord.mockResolvedValue({
      keyKind: "primaryIdentifier",
      key: "E3EYXPSYURQIM9",
      resourceType: "AWS::CloudFront::OriginAccessControl",
      region: "us-east-1",
      createdDate: "2026-05-01T00:00:00Z",
      estimatedMonthlyCost: "$0.00/mo",
      runId: "run-oac-001",
    });
    mockDestroySingleResource.mockResolvedValue({
      success: true,
      resourceType: "AWS::CloudFront::OriginAccessControl",
      identifier: "E3EYXPSYURQIM9",
      arn: "",
    });

    await singleDestroyAction("E3EYXPSYURQIM9", { yes: true });

    expect(mockDestroySingleResource).toHaveBeenCalledTimes(1);
    const callArg = mockDestroySingleResource.mock.calls[0]![0] as {
      resourceType: string;
      identifier: string;
    };
    expect(callArg.resourceType).toBe("AWS::CloudFront::OriginAccessControl");
    expect(callArg.identifier).toBe("E3EYXPSYURQIM9");
  });

  it("Var B: full-ARN destroy path is unaffected (regression guard)", async () => {
    // When RGTA resolves successfully (e.g. CloudFront Distribution full ARN),
    // the provision-log fallback must NOT be reached — resolveResource wins.
    const CF_DIST_ARN =
      "arn:aws:cloudfront::112233445566:distribution/EDFDVBD6EXAMPLE";
    mockResolveResource.mockResolvedValue({
      arn: CF_DIST_ARN,
      resourceType: "AWS::CloudFront::Distribution",
      region: "us-east-1",
      tags: { "managed-by": "assignee-ai" },
      identifier: "EDFDVBD6EXAMPLE",
    });
    mockDestroySingleResource.mockResolvedValue({
      success: true,
      resourceType: "AWS::CloudFront::Distribution",
      identifier: "EDFDVBD6EXAMPLE",
      arn: CF_DIST_ARN,
    });

    await singleDestroyAction(CF_DIST_ARN, { yes: true });

    expect(mockDestroySingleResource).toHaveBeenCalledTimes(1);
    // findProvisionRecord must NOT have been consulted — RGTA resolved it.
    expect(mockFindProvisionRecord).not.toHaveBeenCalled();
  });

  it("Var C: list/destroy parity — any identifier surfaced by list resolves on destroy", async () => {
    // Simulates the parity contract: if fetchManagedResources emits a row
    // with primaryIdentifier = "E3EYXPSYURQIM9", then
    // singleDestroyAction("E3EYXPSYURQIM9") MUST succeed.
    const OAC_ID = "E3EYXPSYURQIM9";
    mockResolveResource.mockResolvedValue(null);
    mockFindProvisionRecord.mockResolvedValue({
      keyKind: "primaryIdentifier",
      key: OAC_ID,
      resourceType: "AWS::CloudFront::OriginAccessControl",
      region: "us-east-1",
      createdDate: "2026-05-02T00:00:00Z",
      estimatedMonthlyCost: "$0.00/mo",
      runId: "run-oac-002",
    });
    mockDestroySingleResource.mockResolvedValue({
      success: true,
      resourceType: "AWS::CloudFront::OriginAccessControl",
      identifier: OAC_ID,
      arn: "",
    });

    // Must not throw; the identifier that list surfaces resolves on destroy.
    await expect(
      singleDestroyAction(OAC_ID, { yes: true }),
    ).resolves.toBeUndefined();
  });

  it("Var D: NotFound from CCAPI delete is treated as success (per feedback_cloudcontrol_notfound_short_circuit)", async () => {
    // If AWS reports NotFound after the delete call, the resource is already
    // gone — classify as success per the short-circuit convention.
    const OAC_ID = "ENOTFOUNDEXAMPLE";
    mockResolveResource.mockResolvedValue(null);
    mockFindProvisionRecord.mockResolvedValue({
      keyKind: "primaryIdentifier",
      key: OAC_ID,
      resourceType: "AWS::CloudFront::OriginAccessControl",
      region: "us-east-1",
      createdDate: "2026-05-03T00:00:00Z",
      estimatedMonthlyCost: "$0.00/mo",
      runId: "run-oac-003",
    });
    // destroySingleResource already handles NotFound internally and returns
    // success: true — this test verifies the whole flow resolves cleanly.
    mockDestroySingleResource.mockResolvedValue({
      success: true,
      resourceType: "AWS::CloudFront::OriginAccessControl",
      identifier: OAC_ID,
      arn: "",
    });

    await expect(
      singleDestroyAction(OAC_ID, { yes: true }),
    ).resolves.toBeUndefined();
  });

  it("Var E: S3::BucketPolicy bare bucket-name resolves via provision-log (generalisation)", async () => {
    // BucketPolicy's CCAPI primaryIdentifier is the bucket name (not an ARN).
    // Same RGTA gap as OAC — must resolve via provision-log fallback.
    const BUCKET_NAME = "my-assignee-managed-bucket";
    mockResolveResource.mockResolvedValue(null);
    mockFindProvisionRecord.mockResolvedValue({
      keyKind: "primaryIdentifier",
      key: BUCKET_NAME,
      resourceType: "AWS::S3::BucketPolicy",
      region: "us-east-1",
      createdDate: "2026-05-04T00:00:00Z",
      estimatedMonthlyCost: "$0.00/mo",
      runId: "run-bp-001",
    });
    mockDestroySingleResource.mockResolvedValue({
      success: true,
      resourceType: "AWS::S3::BucketPolicy",
      identifier: BUCKET_NAME,
      arn: "",
    });

    await singleDestroyAction(BUCKET_NAME, { yes: true });

    expect(mockDestroySingleResource).toHaveBeenCalledTimes(1);
    const callArg = mockDestroySingleResource.mock.calls[0]![0] as {
      resourceType: string;
      identifier: string;
    };
    expect(callArg.resourceType).toBe("AWS::S3::BucketPolicy");
    expect(callArg.identifier).toBe(BUCKET_NAME);
  });

  // T1-1 (Q-M-001): getCostSavingsEstimate 3-arg signature regression guard.
  //
  // PR #37 Defect 3 introduced a `resourceType` arg at position [1] of
  // getCostSavingsEstimate so the destroy path can fall back to the
  // pricing-decomposer registry for KMS/Lambda/etc. when the cost-explorer
  // MCP and provision-log are both silent.  The previous vi.fn stub in this
  // file accepted ANY call shape — so if a future refactor silently dropped
  // the resourceType arg, all tests would stay green while the decomposer
  // fallback would silently break.
  //
  // This test pins the 3-arg call signature by asserting that arg[1] (the
  // resourceType) is a non-empty AWS:: string. It covers the S3 happy-path
  // (RGTA resolves the resource, destroy succeeds) because that path is the
  // primary caller of getCostSavingsEstimate with a known resourceType.
  it("T1-1: getCostSavingsEstimate receives the correct resourceType as arg[1] (3-arg signature guard)", async () => {
    const S3_ARN = "arn:aws:s3:::my-bucket-1234567890";
    mockResolveResource.mockResolvedValue({
      arn: S3_ARN,
      resourceType: "AWS::S3::Bucket",
      region: "us-east-1",
      tags: { "managed-by": "assignee-ai" },
      identifier: "my-bucket-1234567890",
    });
    mockDestroySingleResource.mockResolvedValue({
      success: true,
      resourceType: "AWS::S3::Bucket",
      identifier: "my-bucket-1234567890",
      arn: S3_ARN,
    });

    await singleDestroyAction(S3_ARN, { yes: true });

    // Verify getCostSavingsEstimate was called.
    expect(mockGetCostSavingsEstimate).toHaveBeenCalled();

    // arg[1] must be the AWS CloudFormation resource type string — NOT an
    // array (which would indicate the legacy 2-arg form without resourceType).
    // If the destroy flow regresses to passing mcpTools as arg[1] (dropping
    // resourceType), this assertion fires and catches the regression.
    const callArgs = mockGetCostSavingsEstimate.mock.calls[0]!;
    const resourceTypeArg = callArgs[1];
    expect(typeof resourceTypeArg).toBe("string");
    expect(resourceTypeArg as string).toMatch(/^AWS::/);
    expect(resourceTypeArg).toBe("AWS::S3::Bucket");
  });
});
