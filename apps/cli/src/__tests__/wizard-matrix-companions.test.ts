/**
 * Wizard Interaction Matrix — Companion Resource Coverage.
 *
 * Companion resources can come from two distinct hooks on a `ResourcePlugin`:
 *
 *   1. `toCfn(desiredState)` returning **multiple** `CfnOutput` items —
 *      used when the primary resource and its companions form a single
 *      indivisible unit (e.g., EC2::NatGateway always needs an EC2::EIP
 *      when ConnectivityType=public; EC2::RouteTable always needs a
 *      SubnetRouteTableAssociation when SubnetId is provided).
 *
 *   2. `companionResources(desiredState)` — used when the companion can be
 *      derived from desiredState but isn't part of the primary toCfn output
 *      (e.g., ECS::Cluster auto-provisioning a Logs::LogGroup, RDS auto-
 *      provisioning a SecretsManager secret).
 *
 * This file exercises both paths and asserts the expected companion
 * resource types appear in the output for known scenarios.
 *
 * @see _bmad-output/implementation-artifacts/wizard-interaction-matrix.md — AC #12
 */

import { describe, it, expect } from "vitest";
import {
  defaultPluginRegistry,
  RESOURCE_TYPES,
  COMPANION_RESOURCE_TYPES,
} from "@assignee/core";
import type { CfnOutput, ResourcePlugin } from "@assignee/core";
import { PLUGINS_WITH_COMPANIONS } from "./fixtures/wizard-matrix-plugins.js";

function mustGet(resourceType: string): ResourcePlugin {
  const plugin = defaultPluginRegistry.get(resourceType);
  if (!plugin) throw new Error(`missing plugin: ${resourceType}`);
  return plugin;
}

describe("companion resources — coverage invariants", () => {
  it("at least one plugin defines a companionResources() hook", () => {
    expect(PLUGINS_WITH_COMPANIONS.length).toBeGreaterThan(0);
  });
});

// ── toCfn-driven companions ─────────────────────────────────────────────────

describe("EC2::NatGateway — toCfn() emits an EIP companion when public", () => {
  const plugin = mustGet(RESOURCE_TYPES.EC2_NAT_GATEWAY);

  it("public connectivity → NatGateway + EIP both produced", () => {
    expect(plugin.toCfn).toBeDefined();
    const outputs: CfnOutput[] = plugin.toCfn!({
      ConnectivityType: "public",
      SubnetId: "subnet-0a1b2c3d4e5f6789a",
    });
    const types = outputs.map((o) => o.type);
    expect(types).toContain(COMPANION_RESOURCE_TYPES.EC2_EIP);
    expect(types).toContain(RESOURCE_TYPES.EC2_NAT_GATEWAY);
  });

  it("private connectivity → no EIP companion", () => {
    const outputs: CfnOutput[] = plugin.toCfn!({
      ConnectivityType: "private",
      SubnetId: "subnet-0a1b2c3d4e5f6789a",
    });
    const types = outputs.map((o) => o.type);
    expect(types).not.toContain(COMPANION_RESOURCE_TYPES.EC2_EIP);
    expect(types).toContain(RESOURCE_TYPES.EC2_NAT_GATEWAY);
  });

  it("public NatGateway has AllocationId wired to EIP via !GetAtt", () => {
    const outputs: CfnOutput[] = plugin.toCfn!({
      ConnectivityType: "public",
      SubnetId: "subnet-0a1b2c3d4e5f6789a",
    });
    const natGw = outputs.find(
      (o) => o.type === RESOURCE_TYPES.EC2_NAT_GATEWAY,
    );
    const eip = outputs.find(
      (o) => o.type === COMPANION_RESOURCE_TYPES.EC2_EIP,
    );
    expect(natGw).toBeDefined();
    expect(eip).toBeDefined();
    const allocationRef = natGw?.properties["AllocationId"] as
      | { "Fn::GetAtt": [string, string] }
      | undefined;
    expect(allocationRef?.["Fn::GetAtt"]?.[0]).toBe(eip?.logicalId);
    expect(allocationRef?.["Fn::GetAtt"]?.[1]).toBe("AllocationId");
  });
});

describe("EC2::RouteTable — toCfn() emits a SubnetRouteTableAssociation companion", () => {
  const plugin = mustGet(RESOURCE_TYPES.EC2_ROUTE_TABLE);

  it("with SubnetId → RouteTable + SubnetRouteTableAssociation produced", () => {
    expect(plugin.toCfn).toBeDefined();
    const outputs: CfnOutput[] = plugin.toCfn!({
      VpcId: "vpc-0123456789abcdef0",
      SubnetId: "subnet-0a1b2c3d4e5f6789a",
    });
    const types = outputs.map((o) => o.type);
    expect(types).toContain(RESOURCE_TYPES.EC2_ROUTE_TABLE);
    expect(types).toContain(RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION);
  });

  it("without SubnetId → only the RouteTable is produced", () => {
    const outputs: CfnOutput[] = plugin.toCfn!({
      VpcId: "vpc-0123456789abcdef0",
    });
    const types = outputs.map((o) => o.type);
    expect(types).toContain(RESOURCE_TYPES.EC2_ROUTE_TABLE);
    expect(types).not.toContain(
      RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
    );
  });
});

// ── companionResources-driven companions ────────────────────────────────────

describe("ECS::Cluster — companionResources() emits a LogGroup", () => {
  const plugin = mustGet(RESOURCE_TYPES.ECS_CLUSTER);

  it("with ClusterName → LogGroup is generated under /ecs/<name>", () => {
    expect(plugin.companionResources).toBeDefined();
    const outputs = plugin.companionResources!({
      ClusterName: "my-test-cluster",
    });
    expect(outputs.length).toBeGreaterThan(0);
    const logGroup = outputs.find(
      (o) => o.type === RESOURCE_TYPES.LOGS_LOG_GROUP,
    );
    expect(logGroup).toBeDefined();
    expect(logGroup?.properties["LogGroupName"]).toBe("/ecs/my-test-cluster");
  });

  it("without ClusterName → no companions are produced", () => {
    const outputs = plugin.companionResources!({});
    expect(outputs.length).toBe(0);
  });
});

// ── Generic invariant: every companionResources() hook is callable ──────────

describe.each(PLUGINS_WITH_COMPANIONS.map((p) => [p.resourceType, p] as const))(
  "companionResources() invariants — %s",
  (_resourceType, plugin) => {
    it("is a function and never throws on an empty desiredState", () => {
      expect(typeof plugin.companionResources).toBe("function");
      expect(() => plugin.companionResources!({})).not.toThrow();
    });

    it("returns an array of well-formed CfnOutput objects", () => {
      const outputs = plugin.companionResources!({});
      expect(Array.isArray(outputs)).toBe(true);
      for (const out of outputs) {
        expect(typeof out.logicalId).toBe("string");
        expect(out.logicalId.length).toBeGreaterThan(0);
        expect(typeof out.type).toBe("string");
        expect(out.type.startsWith("AWS::")).toBe(true);
        expect(typeof out.properties).toBe("object");
      }
    });
  },
);
