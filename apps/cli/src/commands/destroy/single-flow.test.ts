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
} = vi.hoisted(() => ({
  mockFindProvisionRecord: vi.fn(),
  mockResolveResource: vi.fn(),
  mockDestroySingleResource: vi.fn(),
}));

// ── @assignee/core: real isNonTaggableConstruct, stubbed findProvisionRecord ──
vi.mock("@assignee/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@assignee/core")>();
  return {
    ...real,
    findProvisionRecord: (...args: unknown[]) =>
      mockFindProvisionRecord(...args),
  };
});

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

vi.mock("../../services/billing.js", () => ({
  getCostSavingsEstimate: vi.fn().mockResolvedValue("$3.60/mo"),
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
  "arn:aws:ec2:us-east-1:210987654321:elastic-ip/eipalloc-0a4b5c6d7e8f90123";

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
});
