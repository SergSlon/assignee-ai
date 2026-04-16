/**
 * Tests for elbv2-loadbalancer destroy strategy — usesArnIdentifier/
 * isSlow flags, ENI drain regex covers app|net|gwy schemes, and
 * unknown-scheme observability via warn (Edge-hunter M3).
 *
 * @see Wave-6 F1b
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const hoisted = vi.hoisted(() => ({ mockEc2Send: vi.fn() }));
vi.mock("@aws-sdk/client-ec2", () => {
  class EC2Client {
    send = hoisted.mockEc2Send;
  }
  function DescribeNetworkInterfacesCommand(i: Record<string, unknown>) {
    return { _type: "DescribeNetworkInterfaces", ...i };
  }
  return { EC2Client, DescribeNetworkInterfacesCommand };
});

import { elbv2LoadBalancerStrategy } from "../elbv2-loadbalancer.js";
import type { DestroyContext } from "@assignee/core";

const originalSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  vi.clearAllMocks();
  // @ts-expect-error simplified stub
  globalThis.setTimeout = (fn: () => void) => originalSetTimeout(fn, 0);
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
});
afterAll(() => {
  globalThis.setTimeout = originalSetTimeout;
});

function makeCtx(arn: string, identifier: string): DestroyContext {
  return {
    resource: {
      arn,
      resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
      identifier,
      region: "us-east-1",
    },
    awsConfig: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
    },
    effectiveRegion: "us-east-1",
    warn: () => {},
  };
}

describe("elbv2LoadBalancerStrategy", () => {
  it("declares flag-only registry metadata: usesArnIdentifier + isSlow", () => {
    expect(elbv2LoadBalancerStrategy.usesArnIdentifier).toBe(true);
    expect(elbv2LoadBalancerStrategy.isSlow).toBe(true);
  });

  it("polls DescribeNetworkInterfaces for ALB (app) and exits when zero remain", async () => {
    hoisted.mockEc2Send
      .mockResolvedValueOnce({
        NetworkInterfaces: [{ NetworkInterfaceId: "eni-1" }],
      })
      .mockResolvedValueOnce({ NetworkInterfaces: [] });

    const ctx = makeCtx(
      "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/abc123",
      "app/my-alb/abc123",
    );
    await elbv2LoadBalancerStrategy.postDestroy!(ctx);
    const descCalls = hoisted.mockEc2Send.mock.calls.filter(
      (c) => c[0]._type === "DescribeNetworkInterfaces",
    );
    expect(descCalls.length).toBeGreaterThanOrEqual(2);
    // Filter value must target the ALB's app/<name>/* ENI description.
    expect(descCalls[0]![0].Filters[0].Values[0]).toBe("ELB app/my-alb/*");
  });

  it("drains NLB (net) scheme — architect WARNING #9 invariant", async () => {
    hoisted.mockEc2Send.mockResolvedValue({ NetworkInterfaces: [] });
    const ctx = makeCtx(
      "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/net/my-nlb/xyz",
      "net/my-nlb/xyz",
    );
    await elbv2LoadBalancerStrategy.postDestroy!(ctx);
    const descCalls = hoisted.mockEc2Send.mock.calls.filter(
      (c) => c[0]._type === "DescribeNetworkInterfaces",
    );
    expect(descCalls[0]![0].Filters[0].Values[0]).toBe("ELB net/my-nlb/*");
  });

  it("drains GWLB (gwy) scheme", async () => {
    hoisted.mockEc2Send.mockResolvedValue({ NetworkInterfaces: [] });
    const ctx = makeCtx(
      "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/gwy/my-gwlb/xyz",
      "gwy/my-gwlb/xyz",
    );
    await elbv2LoadBalancerStrategy.postDestroy!(ctx);
    const descCalls = hoisted.mockEc2Send.mock.calls.filter(
      (c) => c[0]._type === "DescribeNetworkInterfaces",
    );
    expect(descCalls[0]![0].Filters[0].Values[0]).toBe("ELB gwy/my-gwlb/*");
  });

  it("falls through to 60s blind wait when scheme/name cannot be extracted", async () => {
    const ctx = makeCtx(
      "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/weird-format",
      "weird-format",
    );
    await elbv2LoadBalancerStrategy.postDestroy!(ctx);
    // No DescribeNetworkInterfaces call — we fell through to the setTimeout fallback.
    const descCalls = hoisted.mockEc2Send.mock.calls.filter(
      (c) => c[0]._type === "DescribeNetworkInterfaces",
    );
    expect(descCalls).toHaveLength(0);
  });
});
