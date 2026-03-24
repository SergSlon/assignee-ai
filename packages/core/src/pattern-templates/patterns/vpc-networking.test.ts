import { describe, it, expect } from "vitest";
import {
  vpcNetworkingPattern,
  vpcPublicOnlyPattern,
} from "./vpc-networking.js";
import { PatternRegistry } from "../registry.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";

// ── Helper ────────────────────────────────────────────────────────────────────

function buildRegistry(): PatternRegistry {
  const r = new PatternRegistry();
  // Register public-only first (same order as defaultPatternRegistry)
  r.register(vpcPublicOnlyPattern);
  r.register(vpcNetworkingPattern);
  return r;
}

/** Collect all resourceIds from a pattern's dependencyOrder (flattened). */
function allDepIds(pattern: typeof vpcNetworkingPattern): string[] {
  return pattern.dependencyOrder.flat();
}

/** Collect all resourceIds from resourceList. */
function allResourceIds(pattern: typeof vpcNetworkingPattern): string[] {
  return pattern.resourceList.map((r) => r.resourceId);
}

// ── Full VPC Networking Pattern ───────────────────────────────────────────────

describe("vpcNetworkingPattern — full compound output", () => {
  const pattern = vpcNetworkingPattern;

  it("has patternId 'vpc-networking'", () => {
    expect(pattern.patternId).toBe("vpc-networking");
  });

  it("has at least 5 keywords for detection", () => {
    expect(pattern.keywords.length).toBeGreaterThanOrEqual(5);
  });

  it("contains all 17 expected resources", () => {
    expect(pattern.resourceList).toHaveLength(17);
  });

  it("includes all required resource types", () => {
    const types = pattern.resourceList.map((r) => r.resourceType);

    // VPC
    expect(types.filter((t) => t === RESOURCE_TYPES.EC2_VPC)).toHaveLength(1);
    // 4 Subnets (2 public, 2 private)
    expect(types.filter((t) => t === RESOURCE_TYPES.EC2_SUBNET)).toHaveLength(
      4,
    );
    // 1 InternetGateway
    expect(
      types.filter((t) => t === RESOURCE_TYPES.EC2_INTERNET_GATEWAY),
    ).toHaveLength(1);
    // 1 VPCGatewayAttachment
    expect(
      types.filter((t) => t === "AWS::EC2::VPCGatewayAttachment"),
    ).toHaveLength(1);
    // 2 RouteTables
    expect(
      types.filter((t) => t === RESOURCE_TYPES.EC2_ROUTE_TABLE),
    ).toHaveLength(2);
    // 2 Routes
    expect(types.filter((t) => t === RESOURCE_TYPES.EC2_ROUTE)).toHaveLength(2);
    // 1 NatGateway
    expect(
      types.filter((t) => t === RESOURCE_TYPES.EC2_NAT_GATEWAY),
    ).toHaveLength(1);
    // 1 EIP
    expect(types.filter((t) => t === "AWS::EC2::EIP")).toHaveLength(1);
    // 4 SubnetRouteTableAssociations
    expect(
      types.filter((t) => t === "AWS::EC2::SubnetRouteTableAssociation"),
    ).toHaveLength(4);
  });

  it("all dependencyOrder resourceIds exist in resourceList", () => {
    const validIds = new Set(allResourceIds(pattern));
    for (const id of allDepIds(pattern)) {
      expect(
        validIds.has(id),
        `resourceId "${id}" in dependencyOrder not found in resourceList`,
      ).toBe(true);
    }
  });

  it("every resourceId in resourceList appears in dependencyOrder", () => {
    const depIds = new Set(allDepIds(pattern));
    for (const id of allResourceIds(pattern)) {
      expect(
        depIds.has(id),
        `resourceId "${id}" in resourceList not found in dependencyOrder`,
      ).toBe(true);
    }
  });

  it("every resourceId has a defaultOptions entry", () => {
    for (const id of allResourceIds(pattern)) {
      expect(
        pattern.defaultOptions[id],
        `missing defaultOptions for "${id}"`,
      ).toBeDefined();
    }
  });
});

describe("vpcNetworkingPattern — resource reference wiring", () => {
  const opts = vpcNetworkingPattern.defaultOptions;

  it("VPC has correct CIDR and DNS settings", () => {
    expect(opts["vpc"]).toMatchObject({
      CidrBlock: "10.0.0.0/16",
      EnableDnsSupport: true,
      EnableDnsHostnames: true,
    });
  });

  it("public subnets reference VpcId via Ref", () => {
    expect(opts["public-subnet-1"]?.["VpcId"]).toEqual({ Ref: "vpc" });
    expect(opts["public-subnet-2"]?.["VpcId"]).toEqual({ Ref: "vpc" });
  });

  it("private subnets reference VpcId via Ref", () => {
    expect(opts["private-subnet-1"]?.["VpcId"]).toEqual({ Ref: "vpc" });
    expect(opts["private-subnet-2"]?.["VpcId"]).toEqual({ Ref: "vpc" });
  });

  it("public subnets have MapPublicIpOnLaunch = true", () => {
    expect(opts["public-subnet-1"]?.["MapPublicIpOnLaunch"]).toBe(true);
    expect(opts["public-subnet-2"]?.["MapPublicIpOnLaunch"]).toBe(true);
  });

  it("private subnets have MapPublicIpOnLaunch = false", () => {
    expect(opts["private-subnet-1"]?.["MapPublicIpOnLaunch"]).toBe(false);
    expect(opts["private-subnet-2"]?.["MapPublicIpOnLaunch"]).toBe(false);
  });

  it("IGW attachment references VpcId and InternetGatewayId", () => {
    expect(opts["igw-attachment"]).toMatchObject({
      VpcId: { Ref: "vpc" },
      InternetGatewayId: { Ref: "igw" },
    });
  });

  it("route tables reference VpcId", () => {
    expect(opts["public-route-table"]?.["VpcId"]).toEqual({ Ref: "vpc" });
    expect(opts["private-route-table"]?.["VpcId"]).toEqual({ Ref: "vpc" });
  });

  it("public route targets IGW via GatewayId", () => {
    expect(opts["public-route"]).toMatchObject({
      RouteTableId: { Ref: "public-route-table" },
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: { Ref: "igw" },
    });
  });

  it("private route targets NatGateway via NatGatewayId", () => {
    expect(opts["private-route"]).toMatchObject({
      RouteTableId: { Ref: "private-route-table" },
      DestinationCidrBlock: "0.0.0.0/0",
      NatGatewayId: { Ref: "nat-gateway" },
    });
  });

  it("NatGateway references public subnet and EIP AllocationId", () => {
    expect(opts["nat-gateway"]).toMatchObject({
      SubnetId: { Ref: "public-subnet-1" },
      ConnectivityType: "public",
      AllocationId: { "Fn::GetAtt": ["nat-eip", "AllocationId"] },
    });
  });

  it("EIP is configured for VPC domain", () => {
    expect(opts["nat-eip"]).toMatchObject({ Domain: "vpc" });
  });

  it("subnet-RT associations wire SubnetId and RouteTableId correctly", () => {
    expect(opts["public-subnet-1-rt-assoc"]).toMatchObject({
      SubnetId: { Ref: "public-subnet-1" },
      RouteTableId: { Ref: "public-route-table" },
    });
    expect(opts["public-subnet-2-rt-assoc"]).toMatchObject({
      SubnetId: { Ref: "public-subnet-2" },
      RouteTableId: { Ref: "public-route-table" },
    });
    expect(opts["private-subnet-1-rt-assoc"]).toMatchObject({
      SubnetId: { Ref: "private-subnet-1" },
      RouteTableId: { Ref: "private-route-table" },
    });
    expect(opts["private-subnet-2-rt-assoc"]).toMatchObject({
      SubnetId: { Ref: "private-subnet-2" },
      RouteTableId: { Ref: "private-route-table" },
    });
  });
});

describe("vpcNetworkingPattern — DependsOn ordering", () => {
  const depOrder = vpcNetworkingPattern.dependencyOrder;

  /** Returns the group index where a resourceId first appears. */
  function groupOf(id: string): number {
    return depOrder.findIndex((group) => group.includes(id));
  }

  it("VPC is in the first group (group 0)", () => {
    expect(groupOf("vpc")).toBe(0);
  });

  it("subnets and IGW come after VPC", () => {
    expect(groupOf("public-subnet-1")).toBeGreaterThan(groupOf("vpc"));
    expect(groupOf("public-subnet-2")).toBeGreaterThan(groupOf("vpc"));
    expect(groupOf("private-subnet-1")).toBeGreaterThan(groupOf("vpc"));
    expect(groupOf("private-subnet-2")).toBeGreaterThan(groupOf("vpc"));
    expect(groupOf("igw")).toBeGreaterThan(groupOf("vpc"));
  });

  it("IGW attachment comes after IGW", () => {
    expect(groupOf("igw-attachment")).toBeGreaterThan(groupOf("igw"));
  });

  it("route tables come after VPC", () => {
    expect(groupOf("public-route-table")).toBeGreaterThan(groupOf("vpc"));
    expect(groupOf("private-route-table")).toBeGreaterThan(groupOf("vpc"));
  });

  it("public route comes after public route table and IGW", () => {
    expect(groupOf("public-route")).toBeGreaterThan(
      groupOf("public-route-table"),
    );
    expect(groupOf("public-route")).toBeGreaterThan(groupOf("igw"));
  });

  it("NatGateway comes after public subnet and EIP", () => {
    expect(groupOf("nat-gateway")).toBeGreaterThan(groupOf("public-subnet-1"));
    expect(groupOf("nat-gateway")).toBeGreaterThan(groupOf("nat-eip"));
  });

  it("private route comes after private route table and NatGateway", () => {
    expect(groupOf("private-route")).toBeGreaterThan(
      groupOf("private-route-table"),
    );
    expect(groupOf("private-route")).toBeGreaterThan(groupOf("nat-gateway"));
  });

  it("subnet-RT associations come after both subnets and route tables", () => {
    const assocGroup = groupOf("public-subnet-1-rt-assoc");
    expect(assocGroup).toBeGreaterThan(groupOf("public-subnet-1"));
    expect(assocGroup).toBeGreaterThan(groupOf("public-route-table"));

    const privateAssocGroup = groupOf("private-subnet-1-rt-assoc");
    expect(privateAssocGroup).toBeGreaterThan(groupOf("private-subnet-1"));
    expect(privateAssocGroup).toBeGreaterThan(groupOf("private-route-table"));
  });

  it("no forward references — every Ref target appears in an earlier or same group", () => {
    const opts = vpcNetworkingPattern.defaultOptions;
    const flatOrder = depOrder.flat();

    for (let groupIdx = 0; groupIdx < depOrder.length; groupIdx++) {
      for (const resourceId of depOrder[groupIdx]!) {
        const resourceOpts = opts[resourceId] ?? {};
        // Find all { Ref: "xxx" } values
        const refs =
          JSON.stringify(resourceOpts).match(/"Ref":"([^"]+)"/g) ?? [];
        for (const refMatch of refs) {
          const targetId = refMatch.replace(/"Ref":"/, "").replace(/"$/, "");
          const targetGroup = depOrder.findIndex((g) => g.includes(targetId));
          expect(
            targetGroup,
            `${resourceId} references "${targetId}" which is not in dependencyOrder`,
          ).toBeGreaterThanOrEqual(0);
          expect(
            targetGroup,
            `${resourceId} (group ${groupIdx}) references "${targetId}" (group ${targetGroup}) — forward reference`,
          ).toBeLessThanOrEqual(groupIdx);
        }
        // Find all { "Fn::GetAtt": ["xxx", ...] } values
        const getAtts =
          JSON.stringify(resourceOpts).match(/"Fn::GetAtt":\["([^"]+)"/g) ?? [];
        for (const gaMatch of getAtts) {
          const targetId = gaMatch
            .replace(/"Fn::GetAtt":\["/, "")
            .replace(/"$/, "");
          const targetGroup = depOrder.findIndex((g) => g.includes(targetId));
          expect(
            targetGroup,
            `${resourceId} Fn::GetAtt references "${targetId}" which is not in dependencyOrder`,
          ).toBeGreaterThanOrEqual(0);
          expect(
            targetGroup,
            `${resourceId} (group ${groupIdx}) Fn::GetAtt "${targetId}" (group ${targetGroup}) — forward reference`,
          ).toBeLessThanOrEqual(groupIdx);
        }
      }
    }
  });
});

// ── Public-Only Variant ───────────────────────────────────────────────────────

describe("vpcPublicOnlyPattern — public-only variant", () => {
  const pattern = vpcPublicOnlyPattern;

  it("has patternId 'vpc-public-only'", () => {
    expect(pattern.patternId).toBe("vpc-public-only");
  });

  it("has at least 5 keywords", () => {
    expect(pattern.keywords.length).toBeGreaterThanOrEqual(5);
  });

  it("contains expected number of resources (no private resources)", () => {
    // VPC + 2 public subnets + IGW + IGW attachment + 1 RT + 1 Route + 2 associations = 9
    expect(pattern.resourceList).toHaveLength(9);
  });

  it("does NOT include NatGateway", () => {
    const types = pattern.resourceList.map((r) => r.resourceType);
    expect(types).not.toContain(RESOURCE_TYPES.EC2_NAT_GATEWAY);
  });

  it("does NOT include EIP", () => {
    const types = pattern.resourceList.map((r) => r.resourceType);
    expect(types).not.toContain("AWS::EC2::EIP");
  });

  it("does NOT include private subnets", () => {
    const ids = pattern.resourceList.map((r) => r.resourceId);
    expect(ids).not.toContain("private-subnet-1");
    expect(ids).not.toContain("private-subnet-2");
  });

  it("does NOT include private route table or private route", () => {
    const ids = pattern.resourceList.map((r) => r.resourceId);
    expect(ids).not.toContain("private-route-table");
    expect(ids).not.toContain("private-route");
  });

  it("does NOT include private subnet RT associations", () => {
    const ids = pattern.resourceList.map((r) => r.resourceId);
    expect(ids).not.toContain("private-subnet-1-rt-assoc");
    expect(ids).not.toContain("private-subnet-2-rt-assoc");
  });

  it("still includes VPC, IGW, public RouteTable, and public Route", () => {
    const ids = pattern.resourceList.map((r) => r.resourceId);
    expect(ids).toContain("vpc");
    expect(ids).toContain("igw");
    expect(ids).toContain("igw-attachment");
    expect(ids).toContain("public-route-table");
    expect(ids).toContain("public-route");
  });

  it("still includes 2 public subnets", () => {
    const ids = pattern.resourceList.map((r) => r.resourceId);
    expect(ids).toContain("public-subnet-1");
    expect(ids).toContain("public-subnet-2");
  });

  it("all dependencyOrder resourceIds exist in resourceList", () => {
    const validIds = new Set(allResourceIds(pattern));
    for (const id of allDepIds(pattern)) {
      expect(
        validIds.has(id),
        `resourceId "${id}" in dependencyOrder not found in resourceList`,
      ).toBe(true);
    }
  });

  it("every resourceId in resourceList appears in dependencyOrder", () => {
    const depIds = new Set(allDepIds(pattern));
    for (const id of allResourceIds(pattern)) {
      expect(
        depIds.has(id),
        `resourceId "${id}" in resourceList not found in dependencyOrder`,
      ).toBe(true);
    }
  });

  it("every resourceId has a defaultOptions entry", () => {
    for (const id of allResourceIds(pattern)) {
      expect(
        pattern.defaultOptions[id],
        `missing defaultOptions for "${id}"`,
      ).toBeDefined();
    }
  });

  it("public route targets IGW (not NatGateway)", () => {
    const routeOpts = pattern.defaultOptions["public-route"];
    expect(routeOpts?.["GatewayId"]).toEqual({ Ref: "igw" });
    expect(routeOpts?.["NatGatewayId"]).toBeUndefined();
  });
});

// ── Keyword Detection ─────────────────────────────────────────────────────────

describe("VPC pattern keyword detection", () => {
  const registry = buildRegistry();

  it("detects full VPC pattern for 'vpc with public and private subnets'", () => {
    expect(
      registry.detect("create a vpc with public and private subnets"),
    ).toBe(vpcNetworkingPattern);
  });

  it("detects full VPC pattern for 'vpc with subnets'", () => {
    expect(registry.detect("set up a vpc with subnets")).toBe(
      vpcNetworkingPattern,
    );
  });

  it("detects full VPC pattern for 'vpc with networking'", () => {
    expect(registry.detect("vpc with networking")).toBe(vpcNetworkingPattern);
  });

  it("detects full VPC pattern for 'create a vpc'", () => {
    expect(registry.detect("create a vpc")).toBe(vpcNetworkingPattern);
  });

  it("detects public-only variant for 'vpc public only'", () => {
    expect(registry.detect("I need a vpc public only")).toBe(
      vpcPublicOnlyPattern,
    );
  });

  it("detects public-only variant for 'vpc no private subnets'", () => {
    expect(registry.detect("vpc no private subnets please")).toBe(
      vpcPublicOnlyPattern,
    );
  });

  it("detects public-only variant for 'simple vpc'", () => {
    expect(registry.detect("set up a simple vpc")).toBe(vpcPublicOnlyPattern);
  });

  it("detects public-only variant for 'cheap vpc'", () => {
    expect(registry.detect("I need a cheap vpc")).toBe(vpcPublicOnlyPattern);
  });

  it("detects public-only variant for 'vpc without nat'", () => {
    expect(registry.detect("vpc without nat")).toBe(vpcPublicOnlyPattern);
  });
});

// ── Auxiliary resources marked provisionable: false ───────────────────────────

describe("VPC pattern provisionable flags", () => {
  it("full pattern: VPCGatewayAttachment is provisionable: false", () => {
    const r = vpcNetworkingPattern.resourceList.find(
      (r) => r.resourceId === "igw-attachment",
    );
    expect(r?.provisionable).toBe(false);
  });

  it("full pattern: EIP is provisionable: false", () => {
    const r = vpcNetworkingPattern.resourceList.find(
      (r) => r.resourceId === "nat-eip",
    );
    expect(r?.provisionable).toBe(false);
  });

  it("full pattern: SubnetRouteTableAssociations are provisionable: false", () => {
    const assocs = vpcNetworkingPattern.resourceList.filter((r) =>
      r.resourceId.endsWith("-rt-assoc"),
    );
    expect(assocs).toHaveLength(4);
    for (const a of assocs) {
      expect(a.provisionable).toBe(false);
    }
  });

  it("public-only: SubnetRouteTableAssociations are provisionable: false", () => {
    const assocs = vpcPublicOnlyPattern.resourceList.filter((r) =>
      r.resourceId.endsWith("-rt-assoc"),
    );
    expect(assocs).toHaveLength(2);
    for (const a of assocs) {
      expect(a.provisionable).toBe(false);
    }
  });
});
