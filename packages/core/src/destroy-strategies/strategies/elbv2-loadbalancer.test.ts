/**
 * Unit tests for the ELBv2 LoadBalancer destroy strategy (ENI drain postDestroy).
 *
 * Covers:
 *   1. Happy path — ALB ENI drain completes on first poll (0 ENIs)
 *   2. Happy path — NLB scheme regex matched (net/)
 *   3. Happy path — GWLB scheme regex matched (gwy/)
 *   4. Happy path — drain completes after a few polls
 *   5. Edge case — unknown scheme → warns elbv2_scheme_unknown + falls to 60s sleep
 *   6. Edge case — DescribeNetworkInterfaces throws → warns alb_eni_drain_failed
 *   7. Edge case — lbName not extractable from ARN or identifier
 *   8. Strategy metadata check
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { elbv2LoadBalancerStrategy } from "./elbv2-loadbalancer.js";
import type { DestroyContext } from "../types.js";
import { RESOURCE_TYPES } from "../../config/resource-types/named.js";

// ── Hoisted mocks ─────────────────────────────────────────────────────

const { mockEc2Send, mockEc2Destroy, mockRequireAssigneeCredentials } =
  vi.hoisted(() => ({
    mockEc2Send: vi.fn(),
    mockEc2Destroy: vi.fn(),
    mockRequireAssigneeCredentials: vi.fn(),
  }));

vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = mockEc2Send;
    destroy = mockEc2Destroy;
  }
  function DescribeNetworkInterfacesCommand(input: unknown) {
    return { _type: "DescribeNetworkInterfacesCommand", input };
  }
  return { EC2Client, DescribeNetworkInterfacesCommand };
});

vi.mock("../../config/aws-credentials.js", () => ({
  requireAssigneeCredentials: mockRequireAssigneeCredentials,
  MissingAssigneeCredentialsError: class MissingAssigneeCredentialsError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "MissingAssigneeCredentialsError";
    }
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────

/** Real ALB ARN format: arn:aws:elasticloadbalancing:us-east-1:ACCOUNT:loadbalancer/app/NAME/HEX */
const ALB_ARN =
  "arn:aws:elasticloadbalancing:us-east-1:210987654321:loadbalancer/app/assignee-alb-prod/1234567890abcdef";
const ALB_IDENTIFIER = "app/assignee-alb-prod/1234567890abcdef";

const NLB_ARN =
  "arn:aws:elasticloadbalancing:us-east-1:210987654321:loadbalancer/net/assignee-nlb-prod/abcdef1234567890";
const GWLB_ARN =
  "arn:aws:elasticloadbalancing:us-east-1:210987654321:loadbalancer/gwy/assignee-gwlb-prod/fedcba0987654321";

function makeCtx(
  overrides: Partial<
    DestroyContext & { resource: Partial<DestroyContext["resource"]> }
  > = {},
): DestroyContext {
  return {
    resource: {
      arn: ALB_ARN,
      resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
      identifier: ALB_IDENTIFIER,
      region: "us-east-1",
      ...overrides.resource,
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
  } as DestroyContext;
}

beforeEach(() => {
  mockEc2Send.mockReset();
  mockEc2Destroy.mockReset();
  mockRequireAssigneeCredentials.mockReturnValue({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ── 1. ALB — ENIs already drained (first poll returns 0) ─────────────

describe("elbv2LoadBalancerStrategy.postDestroy — ENIs already drained", () => {
  it("returns on attempt 0 when no ENIs are present (no onProgress emitted)", async () => {
    mockEc2Send.mockResolvedValueOnce({ NetworkInterfaces: [] });

    const ctx = makeCtx();
    const promise = elbv2LoadBalancerStrategy.postDestroy!(ctx);
    await vi.runAllTimersAsync();
    await promise;

    expect(ctx.warn).not.toHaveBeenCalled();
    // No progress on attempt 0
    expect(ctx.onProgress).not.toHaveBeenCalled();
  });
});

// ── 2. NLB scheme regex ───────────────────────────────────────────────

describe("elbv2LoadBalancerStrategy.postDestroy — NLB scheme", () => {
  it("extracts 'net' scheme and queries ENIs using ELB net/ filter", async () => {
    mockEc2Send.mockResolvedValueOnce({ NetworkInterfaces: [] });

    const ctx = makeCtx({
      resource: {
        arn: NLB_ARN,
        identifier: "net/assignee-nlb-prod/abcdef1234567890",
        resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
        region: "us-east-1",
      },
    });
    const promise = elbv2LoadBalancerStrategy.postDestroy!(ctx);
    await vi.runAllTimersAsync();
    await promise;

    const describeCall = (mockEc2Send as Mock).mock.calls[0]![0];
    expect(describeCall.input.Filters[0].Values[0]).toContain("net/");
    expect(ctx.warn).not.toHaveBeenCalled();
  });
});

// ── 3. GWLB scheme regex ──────────────────────────────────────────────

describe("elbv2LoadBalancerStrategy.postDestroy — GWLB scheme", () => {
  it("extracts 'gwy' scheme and queries ENIs using ELB gwy/ filter", async () => {
    mockEc2Send.mockResolvedValueOnce({ NetworkInterfaces: [] });

    const ctx = makeCtx({
      resource: {
        arn: GWLB_ARN,
        identifier: "gwy/assignee-gwlb-prod/fedcba0987654321",
        resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
        region: "us-east-1",
      },
    });
    const promise = elbv2LoadBalancerStrategy.postDestroy!(ctx);
    await vi.runAllTimersAsync();
    await promise;

    const describeCall = (mockEc2Send as Mock).mock.calls[0]![0];
    expect(describeCall.input.Filters[0].Values[0]).toContain("gwy/");
  });
});

// ── 4. Drain completes after a few polls ──────────────────────────────

describe("elbv2LoadBalancerStrategy.postDestroy — drain after polls", () => {
  it("emits progress and drain-complete message after waiting", async () => {
    mockEc2Send
      .mockResolvedValueOnce({
        NetworkInterfaces: [{ NetworkInterfaceId: "eni-abc" }],
      }) // poll 1: 1 ENI
      .mockResolvedValueOnce({ NetworkInterfaces: [] }); // poll 2: drained

    const ctx = makeCtx();
    const promise = elbv2LoadBalancerStrategy.postDestroy!(ctx);
    await vi.runAllTimersAsync();
    await promise;

    // Progress message should be emitted on poll 1 (remaining ENIs)
    expect(ctx.onProgress).toHaveBeenCalledWith(
      expect.stringContaining("1 ALB ENI(s) to release"),
    );
    // Drain complete message on poll 2
    expect(ctx.onProgress).toHaveBeenCalledWith(
      expect.stringContaining("ALB ENI drain complete"),
    );
  });
});

// ── 5. Unknown scheme → elbv2_scheme_unknown warn ─────────────────────

describe("elbv2LoadBalancerStrategy.postDestroy — unknown scheme", () => {
  it("emits elbv2_scheme_unknown warn when scheme is not app|net|gwy", async () => {
    const ctx = makeCtx({
      resource: {
        arn: "arn:aws:elasticloadbalancing:us-east-1:210987654321:loadbalancer/unknown/assignee-lb/abcd",
        identifier: "unknown/assignee-lb/abcd",
        resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
        region: "us-east-1",
      },
    });

    const promise = elbv2LoadBalancerStrategy.postDestroy!(ctx);
    await vi.runAllTimersAsync();
    await promise;

    expect(ctx.warn).toHaveBeenCalledWith(
      "elbv2_scheme_unknown",
      expect.objectContaining({ identifier: "unknown/assignee-lb/abcd" }),
    );
  });
});

// ── 6. DescribeNetworkInterfaces throws → warns alb_eni_drain_failed ──

describe("elbv2LoadBalancerStrategy.postDestroy — poll error non-fatal", () => {
  it("emits alb_eni_drain_failed warn when DescribeNetworkInterfaces throws", async () => {
    mockEc2Send.mockRejectedValueOnce(
      new Error("Forbidden: insufficient permissions"),
    );

    const ctx = makeCtx();
    const promise = elbv2LoadBalancerStrategy.postDestroy!(ctx);
    await vi.runAllTimersAsync();
    await promise;

    expect(ctx.warn).toHaveBeenCalledWith(
      "alb_eni_drain_failed",
      expect.objectContaining({ identifier: ALB_IDENTIFIER }),
    );
  });
});

// ── Strategy metadata ─────────────────────────────────────────────────

describe("elbv2LoadBalancerStrategy metadata", () => {
  it("has the correct resourceType", () => {
    expect(elbv2LoadBalancerStrategy.resourceType).toBe(
      RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    );
  });

  it("is marked slow and uses ARN identifier", () => {
    expect(elbv2LoadBalancerStrategy.usesArnIdentifier).toBe(true);
    expect(elbv2LoadBalancerStrategy.isSlow).toBe(true);
  });

  it("exposes only a postDestroy hook", () => {
    expect(typeof elbv2LoadBalancerStrategy.postDestroy).toBe("function");
    expect(elbv2LoadBalancerStrategy.preDestroy).toBeUndefined();
    expect(elbv2LoadBalancerStrategy.destroy).toBeUndefined();
  });
});
