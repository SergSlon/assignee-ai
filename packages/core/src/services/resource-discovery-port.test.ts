/**
 * Tests for ResourceDiscoveryPort production impl (EPIC-107-2).
 *
 * Mocks the aws-resource-discovery module entirely — no real AWS calls in CI.
 * Per ADR (Winston 2026-05-15, Option D): production impl wraps the existing
 * direct-SDK module and shape-maps DiscoveryOption → ExistingResource.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DiscoveryOption } from "../utils/aws-resource-discovery/types.js";

// ─── Mock aws-resource-discovery module ──────────────────────────────────────
// Follows the vi.mock pattern used across wizard-matrix-fetchers.test.ts etc.

const discoveryMocks = vi.hoisted(() => ({
  discoverVpcs: vi.fn<() => Promise<DiscoveryOption[]>>(),
  discoverDbSubnetGroups: vi.fn<() => Promise<DiscoveryOption[]>>(),
  discoverEcsClusters: vi.fn<() => Promise<DiscoveryOption[]>>(),
  discoverElbs: vi.fn<() => Promise<DiscoveryOption[]>>(),
}));

vi.mock("../utils/aws-resource-discovery/index.js", () => ({
  discoverVpcs: discoveryMocks.discoverVpcs,
  discoverDbSubnetGroups: discoveryMocks.discoverDbSubnetGroups,
  discoverEcsClusters: discoveryMocks.discoverEcsClusters,
  discoverElbs: discoveryMocks.discoverElbs,
  // Passthrough other exports used by barrel
  discoverSubnets: vi.fn().mockResolvedValue([]),
  discoverSecurityGroups: vi.fn().mockResolvedValue([]),
  discoverKeyPairs: vi.fn().mockResolvedValue([]),
  discoverRouteTables: vi.fn().mockResolvedValue([]),
  discoverInternetGateways: vi.fn().mockResolvedValue([]),
  discoverNatGateways: vi.fn().mockResolvedValue([]),
  discoverRdsEngineVersions: vi.fn().mockResolvedValue([]),
  discoverRdsInstanceClasses: vi.fn().mockResolvedValue([]),
  discoverLambdaRuntimes: vi.fn().mockResolvedValue([]),
  discoverEfsFileSystems: vi.fn().mockResolvedValue([]),
  discoverSnsTopics: vi.fn().mockResolvedValue([]),
  discoverKmsKeys: vi.fn().mockResolvedValue([]),
  discoverAmis: vi.fn().mockResolvedValue([]),
  resolveAmiFromOsName: vi.fn().mockResolvedValue(null),
  searchAmis: vi.fn().mockResolvedValue([]),
  discoverInstanceTypes: vi.fn().mockResolvedValue([]),
  clearDiscoveryCache: vi.fn(),
  DiscoveryCacheKey: {
    SUBNETS: "discover-subnets",
    VPCS: "discover-vpcs",
    ECS_CLUSTERS: "discover-ecs-clusters",
  },
}));

vi.mock("../utils/logger/index.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {},
}));

import { productionResourceDiscoveryPort } from "./resource-discovery-port.js";

describe("productionResourceDiscoveryPort", () => {
  const region = "us-east-1";

  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── discoverVpcs ────────────────────────────────────────────────────────

  it("shape-maps DiscoveryOption → ExistingResource for VPCs", async () => {
    discoveryMocks.discoverVpcs.mockResolvedValue([
      {
        value: "vpc-abc123",
        label: "default (vpc-abc123, 172.31.0.0/16 [default])",
      },
    ]);
    const port = productionResourceDiscoveryPort(region);
    const result = await port.discoverVpcs({ region });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "VPC",
      id: "vpc-abc123",
      region: "us-east-1",
    });
  });

  it("returns [] when discoverVpcs returns empty array", async () => {
    discoveryMocks.discoverVpcs.mockResolvedValue([]);
    const port = productionResourceDiscoveryPort(region);
    const result = await port.discoverVpcs({ region });
    expect(result).toHaveLength(0);
  });

  it("returns [] (no crash) when discoverVpcs throws", async () => {
    discoveryMocks.discoverVpcs.mockRejectedValue(new Error("Network error"));
    const port = productionResourceDiscoveryPort(region);
    const result = await port.discoverVpcs({ region });
    expect(result).toHaveLength(0);
  });

  // ── discoverSubnetGroups ────────────────────────────────────────────────

  it("shape-maps DiscoveryOption → ExistingResource for subnet groups", async () => {
    discoveryMocks.discoverDbSubnetGroups.mockResolvedValue([
      { value: "my-sg", label: "my-sg — Public subnets" },
    ]);
    const port = productionResourceDiscoveryPort(region);
    const result = await port.discoverSubnetGroups({ region });
    expect(result[0]).toMatchObject({ kind: "SubnetGroup", id: "my-sg" });
  });

  // ── discoverEcsClusters ─────────────────────────────────────────────────

  it("shape-maps DiscoveryOption → ExistingResource for ECS clusters", async () => {
    discoveryMocks.discoverEcsClusters.mockResolvedValue([
      { value: "my-cluster", label: "my-cluster (3 services)" },
    ]);
    const port = productionResourceDiscoveryPort(region);
    const result = await port.discoverEcsClusters({ region });
    expect(result[0]).toMatchObject({ kind: "EcsCluster", id: "my-cluster" });
  });

  // ── discoverElbs ────────────────────────────────────────────────────────

  it("shape-maps DiscoveryOption → ExistingResource for ELBs", async () => {
    discoveryMocks.discoverElbs.mockResolvedValue([
      {
        value:
          "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/abc",
        label: "my-alb [application]",
      },
    ]);
    const port = productionResourceDiscoveryPort(region);
    const result = await port.discoverElbs({ region });
    expect(result[0]).toMatchObject({ kind: "Elb" });
    expect(result[0]!.id).toContain("loadbalancer");
  });

  // ── ExistingResource shape boundary (destroy isolation) ─────────────────

  it("ExistingResource has no ManagedResource fields (destroy cannot target it)", async () => {
    discoveryMocks.discoverVpcs.mockResolvedValue([
      { value: "vpc-abc", label: "vpc-abc" },
    ]);
    const port = productionResourceDiscoveryPort(region);
    const result = await port.discoverVpcs({ region });
    const er = result[0]!;
    expect("resourceArn" in er).toBe(false);
    expect("provisionedAt" in er).toBe(false);
  });

  // ── EPIC-107-2 R2: region plumbing end-to-end ───────────────────────────

  describe("region plumbing (R2 blocker #1)", () => {
    it("passes opts.region to the underlying SDK helper, not the factory default", async () => {
      discoveryMocks.discoverVpcs.mockResolvedValue([]);
      const port = productionResourceDiscoveryPort("us-east-1");
      await port.discoverVpcs({ region: "eu-west-1" });
      // The SDK helper MUST have been called with the per-call region,
      // not the factory default.
      expect(discoveryMocks.discoverVpcs).toHaveBeenCalledWith("eu-west-1");
    });

    it("falls back to factory default region when opts.region is undefined", async () => {
      discoveryMocks.discoverVpcs.mockResolvedValue([]);
      const port = productionResourceDiscoveryPort("us-east-1");
      await port.discoverVpcs({});
      expect(discoveryMocks.discoverVpcs).toHaveBeenCalledWith("us-east-1");
    });

    it("threads the runId into DISCOVERY_FAILURE log line (R2 MED #6)", async () => {
      const { log } = await import("../utils/logger/index.js");
      discoveryMocks.discoverVpcs.mockRejectedValue(new Error("boom"));
      const port = productionResourceDiscoveryPort("us-east-1", "run-abc-123");
      await port.discoverVpcs({ region: "us-east-1" });
      const logCalls = (log as ReturnType<typeof vi.fn>).mock.calls;
      const failureCall = logCalls.find(
        (c) =>
          (c[0] as { action?: string }).action === undefined &&
          // LOG_ACTIONS is mocked to {} so action is undefined here;
          // identify by other fields
          (c[0] as { runId?: string }).runId === "run-abc-123",
      );
      expect(failureCall).toBeDefined();
      expect((failureCall![0] as { runId: string }).runId).toBe("run-abc-123");
      expect(
        (failureCall![0] as { extras: { region: string } }).extras.region,
      ).toBe("us-east-1");
    });

    it("ExistingResource.region reflects the per-call region (not the factory default)", async () => {
      discoveryMocks.discoverVpcs.mockResolvedValue([
        { value: "vpc-eu", label: "eu-vpc" },
      ]);
      const port = productionResourceDiscoveryPort("us-east-1");
      const result = await port.discoverVpcs({ region: "eu-west-1" });
      expect(result[0]!.region).toBe("eu-west-1");
    });
  });
});
