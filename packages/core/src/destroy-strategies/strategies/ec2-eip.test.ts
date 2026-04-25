/**
 * Unit tests for the EC2 EIP destroy strategy.
 *
 * Covers (Wave 19 Bug #6 — EIP bypass via ec2:ReleaseAddress):
 *   1. Happy path — ReleaseAddress succeeds
 *   2. Edge case — InvalidAllocationID.NotFound → treated as success (already released)
 *   3. Edge case — "does not exist" message → treated as success
 *   4. Edge case — other AWS error → returns hard failure
 *   5. Strategy metadata + extractIdentifier not defined (uses default identifier)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ec2EipStrategy } from "./ec2-eip.js";
import type { DestroyContext } from "../types.js";
import { COMPANION_RESOURCE_TYPES } from "../../config/resource-types/companion.js";

// ── Hoisted mocks ─────────────────────────────────────────────────────

const { mockEc2Send, mockEc2Destroy } = vi.hoisted(() => ({
  mockEc2Send: vi.fn(),
  mockEc2Destroy: vi.fn(),
}));

vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = mockEc2Send;
    destroy = mockEc2Destroy;
  }
  function ReleaseAddressCommand(input: unknown) {
    return { _type: "ReleaseAddressCommand", input };
  }
  return { EC2Client, ReleaseAddressCommand };
});

// ── Fixtures ──────────────────────────────────────────────────────────

const EIP_ALLOC_ID = "eipalloc-0abc123456789def0";
const EIP_ARN = `arn:aws:ec2:us-east-1:210987654321:elastic-ip/${EIP_ALLOC_ID}`;

function makeCtx(overrides: Partial<DestroyContext> = {}): DestroyContext {
  return {
    resource: {
      arn: EIP_ARN,
      resourceType: COMPANION_RESOURCE_TYPES.EC2_EIP,
      identifier: EIP_ALLOC_ID,
      region: "us-east-1",
    },
    awsConfig: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
    },
    effectiveRegion: "us-east-1",
    onProgress: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  mockEc2Send.mockReset();
  mockEc2Destroy.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 1. Happy path — ReleaseAddress succeeds ───────────────────────────

describe("ec2EipStrategy.destroy — happy path", () => {
  it("calls ReleaseAddress with AllocationId and returns success", async () => {
    mockEc2Send.mockResolvedValueOnce({});

    const ctx = makeCtx();
    const outcome = await ec2EipStrategy.destroy!(ctx);

    expect(outcome.success).toBe(true);
    expect(mockEc2Send).toHaveBeenCalledWith(
      expect.objectContaining({
        _type: "ReleaseAddressCommand",
        input: { AllocationId: EIP_ALLOC_ID },
      }),
    );
    expect(mockEc2Destroy).toHaveBeenCalledTimes(1);
  });
});

// ── 2. InvalidAllocationID.NotFound → success ─────────────────────────

describe("ec2EipStrategy.destroy — NotFound treated as success", () => {
  it("returns success when InvalidAllocationID.NotFound is thrown (already released)", async () => {
    mockEc2Send.mockRejectedValueOnce(
      new Error(
        "InvalidAllocationID.NotFound: The allocation ID 'eipalloc-xxx' does not exist",
      ),
    );

    const ctx = makeCtx();
    const outcome = await ec2EipStrategy.destroy!(ctx);

    expect(outcome.success).toBe(true);
    expect(outcome.error).toBeUndefined();
  });
});

// ── 3. "does not exist" message → success ─────────────────────────────

describe("ec2EipStrategy.destroy — does not exist message", () => {
  it("returns success when error message contains 'does not exist'", async () => {
    mockEc2Send.mockRejectedValueOnce(
      new Error("The address does not exist or was already released"),
    );

    const ctx = makeCtx();
    const outcome = await ec2EipStrategy.destroy!(ctx);

    expect(outcome.success).toBe(true);
  });
});

// ── 4. Other AWS error → hard failure ─────────────────────────────────

describe("ec2EipStrategy.destroy — other error", () => {
  it("returns failure with descriptive error for unexpected AWS errors", async () => {
    mockEc2Send.mockRejectedValueOnce(
      new Error("AuthFailure: credentials expired"),
    );

    const ctx = makeCtx();
    const outcome = await ec2EipStrategy.destroy!(ctx);

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("Failed to release EIP");
    expect(outcome.error).toContain(EIP_ALLOC_ID);
    expect(outcome.error).toContain("AuthFailure");
  });
});

// ── Strategy metadata ─────────────────────────────────────────────────

describe("ec2EipStrategy metadata", () => {
  it("has the correct resourceType (COMPANION_RESOURCE_TYPES.EC2_EIP)", () => {
    expect(ec2EipStrategy.resourceType).toBe(COMPANION_RESOURCE_TYPES.EC2_EIP);
  });

  it("exposes only a destroy hook (full CCAPI bypass)", () => {
    expect(typeof ec2EipStrategy.destroy).toBe("function");
    expect(ec2EipStrategy.preDestroy).toBeUndefined();
    expect(ec2EipStrategy.postDestroy).toBeUndefined();
  });

  it("does not set usesArnIdentifier (uses bare identifier from extractIdentifier)", () => {
    expect(ec2EipStrategy.usesArnIdentifier).toBeUndefined();
  });
});
