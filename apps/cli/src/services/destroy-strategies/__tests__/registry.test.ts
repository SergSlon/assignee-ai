/**
 * Tests for DestroyStrategyRegistry — register/get/has/registerAll/
 * registeredTypes, plus overwrite semantics.
 *
 * @see Wave-6 F1a
 */

import { describe, it, expect } from "vitest";

import { DestroyStrategyRegistry } from "@assignee/core";
import type { DestroyStrategy } from "@assignee/core";

const topicStrategy: DestroyStrategy = {
  resourceType: "AWS::SNS::Topic",
  usesArnIdentifier: true,
};

const lbStrategy: DestroyStrategy = {
  resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
  usesArnIdentifier: true,
  isSlow: true,
};

const rdsStrategy: DestroyStrategy = {
  resourceType: "AWS::RDS::DBInstance",
  isSlow: true,
};

describe("DestroyStrategyRegistry", () => {
  it("register() stores a strategy retrievable by resource type", () => {
    const registry = new DestroyStrategyRegistry();
    registry.register(topicStrategy);
    expect(registry.get("AWS::SNS::Topic")).toBe(topicStrategy);
    expect(registry.has("AWS::SNS::Topic")).toBe(true);
  });

  it("get() returns undefined for unregistered types", () => {
    const registry = new DestroyStrategyRegistry();
    registry.register(topicStrategy);
    expect(registry.get("AWS::S3::Bucket")).toBeUndefined();
    expect(registry.has("AWS::S3::Bucket")).toBe(false);
  });

  it("registerAll() bulk-registers every strategy in the array", () => {
    const registry = new DestroyStrategyRegistry();
    registry.registerAll([topicStrategy, lbStrategy, rdsStrategy]);
    expect(registry.has("AWS::SNS::Topic")).toBe(true);
    expect(registry.has("AWS::ElasticLoadBalancingV2::LoadBalancer")).toBe(
      true,
    );
    expect(registry.has("AWS::RDS::DBInstance")).toBe(true);
  });

  it("register() overwrites a prior strategy for the same resource type", () => {
    const registry = new DestroyStrategyRegistry();
    const slowTopic: DestroyStrategy = {
      resourceType: "AWS::SNS::Topic",
      usesArnIdentifier: true,
      isSlow: true,
    };
    registry.register(topicStrategy);
    registry.register(slowTopic);
    expect(registry.get("AWS::SNS::Topic")).toBe(slowTopic);
    // Still a single entry — overwrite, not duplicate.
    expect(registry.registeredTypes()).toEqual(["AWS::SNS::Topic"]);
  });

  it("registeredTypes() returns every registered resource type", () => {
    const registry = new DestroyStrategyRegistry();
    registry.registerAll([topicStrategy, rdsStrategy]);
    const types = registry.registeredTypes().sort();
    expect(types).toEqual(["AWS::RDS::DBInstance", "AWS::SNS::Topic"].sort());
  });

  it("preserves optional metadata flags (usesArnIdentifier, isSlow)", () => {
    const registry = new DestroyStrategyRegistry();
    registry.registerAll([topicStrategy, lbStrategy, rdsStrategy]);
    expect(registry.get("AWS::SNS::Topic")?.usesArnIdentifier).toBe(true);
    expect(registry.get("AWS::SNS::Topic")?.isSlow).toBeUndefined();
    expect(
      registry.get("AWS::ElasticLoadBalancingV2::LoadBalancer")?.isSlow,
    ).toBe(true);
    expect(
      registry.get("AWS::RDS::DBInstance")?.usesArnIdentifier,
    ).toBeUndefined();
    expect(registry.get("AWS::RDS::DBInstance")?.isSlow).toBe(true);
  });
});
