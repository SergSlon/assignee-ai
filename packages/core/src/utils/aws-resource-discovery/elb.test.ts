/**
 * Tests for discoverElbs (EPIC-107-2).
 * Mocks @aws-sdk/client-elastic-load-balancing-v2 — no real AWS calls in CI.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock ELB v2 client ───────────────────────────────────────────────────────

const mockSend = vi.fn();
vi.mock("@aws-sdk/client-elastic-load-balancing-v2", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@aws-sdk/client-elastic-load-balancing-v2")
    >();
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn(() => ({ send: mockSend })),
  };
});

vi.mock("../../config/aws-credentials.js", () => ({
  tryAssigneeCredentials: vi.fn(() => ({
    accessKeyId: "test",
    secretAccessKey: "test",
    sessionToken: "test",
  })),
}));

vi.mock("./cache.js", () => ({
  cachedDiscover: vi.fn((_key: string, fetcher: () => unknown) => fetcher()),
}));

import { discoverElbs } from "./elb.js";

describe("discoverElbs", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns active ALBs with type and ARN", async () => {
    mockSend.mockResolvedValue({
      LoadBalancers: [
        {
          LoadBalancerArn:
            "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/abc",
          LoadBalancerName: "my-alb",
          Type: "application",
          State: { Code: "active" },
        },
        {
          LoadBalancerArn:
            "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/net/my-nlb/def",
          LoadBalancerName: "my-nlb",
          Type: "network",
          State: { Code: "active" },
        },
      ],
    });
    const result = await discoverElbs();
    expect(result).toHaveLength(2);
    expect(result[0]!.value).toContain("app/my-alb");
    expect(result[0]!.label).toContain("[application]");
    expect(result[1]!.label).toContain("[network]");
  });

  it("filters out non-active load balancers", async () => {
    mockSend.mockResolvedValue({
      LoadBalancers: [
        {
          LoadBalancerArn:
            "arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/provisioning/abc",
          LoadBalancerName: "provisioning-alb",
          Type: "application",
          State: { Code: "provisioning" },
        },
        {
          LoadBalancerArn:
            "arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/ready/def",
          LoadBalancerName: "ready-alb",
          Type: "application",
          State: { Code: "active" },
        },
      ],
    });
    const result = await discoverElbs();
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toContain("ready-alb");
  });

  it("returns [] when response has no LoadBalancers", async () => {
    mockSend.mockResolvedValue({});
    const result = await discoverElbs();
    expect(result).toHaveLength(0);
  });
});
