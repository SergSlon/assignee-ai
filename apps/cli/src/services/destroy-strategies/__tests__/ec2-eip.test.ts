/**
 * Tests for ec2-eip destroy strategy — direct hook exercise.
 *
 * @see Wave-6 F1b
 */
import { describe, it, expect, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));
vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = hoisted.mockSend;
    destroy = vi.fn();
  }
  function ReleaseAddressCommand(input: Record<string, unknown>) {
    return { _type: "ReleaseAddress", ...input };
  }
  return { EC2Client, ReleaseAddressCommand };
});

import { ec2EipStrategy } from "@assignee/core";
import type { DestroyContext } from "@assignee/core";

function makeCtx(overrides?: Partial<DestroyContext>): DestroyContext {
  return {
    resource: {
      arn: "arn:aws:ec2:us-east-1:123456789012:elastic-ip/eipalloc-abc",
      resourceType: "AWS::EC2::EIP",
      identifier: "eipalloc-abc",
      region: "us-east-1",
    },
    awsConfig: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
    },
    effectiveRegion: "us-east-1",
    warn: () => {},
    ...overrides,
  };
}

describe("ec2EipStrategy", () => {
  it("returns success when ReleaseAddress succeeds", async () => {
    hoisted.mockSend.mockReset();
    hoisted.mockSend.mockResolvedValue({});
    const outcome = await ec2EipStrategy.destroy!(makeCtx());
    expect(outcome).toEqual({ success: true });
    expect(hoisted.mockSend).toHaveBeenCalledTimes(1);
    expect(hoisted.mockSend.mock.calls[0]![0]).toMatchObject({
      _type: "ReleaseAddress",
      AllocationId: "eipalloc-abc",
    });
  });

  it("treats InvalidAllocationID.NotFound as success (already released)", async () => {
    hoisted.mockSend.mockReset();
    hoisted.mockSend.mockRejectedValue(
      new Error("InvalidAllocationID.NotFound: allocation not found"),
    );
    const outcome = await ec2EipStrategy.destroy!(makeCtx());
    expect(outcome).toEqual({ success: true });
  });

  it("returns structured failure on unexpected AWS error", async () => {
    hoisted.mockSend.mockReset();
    hoisted.mockSend.mockRejectedValue(new Error("AccessDenied"));
    const outcome = await ec2EipStrategy.destroy!(makeCtx());
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("Failed to release EIP eipalloc-abc");
    expect(outcome.error).toContain("AccessDenied");
  });
});
