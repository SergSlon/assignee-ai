/**
 * Tests for MCP free-tier.ts (Stories 40.2, 58-it1-01).
 * Verifies free tier note generation for always-free, usage-limited,
 * and paid resource types, plus a regression guard that ties the MCP
 * shape-adapter to `getFreeTierMaps()` in core.
 */

import { describe, it, expect } from "vitest";
import { getFreeTierMaps } from "@assignee/core";
import { getFreeTierNote } from "../free-tier.js";

describe("getFreeTierNote (MCP)", () => {
  // ── Always-free resources ───────────────────────────────────────────────────

  describe("always-free resources return { type: 'always_free' }", () => {
    const alwaysFreeTypes = [
      "AWS::IAM::Role",
      "AWS::SSM::Parameter",
      "AWS::EC2::VPC",
      "AWS::EC2::Subnet",
      "AWS::EC2::SecurityGroup",
      "AWS::EC2::InternetGateway",
      "AWS::EC2::RouteTable",
      "AWS::EC2::Route",
      "AWS::ECS::Cluster",
    ];

    for (const resourceType of alwaysFreeTypes) {
      it(`returns always_free for ${resourceType}`, () => {
        const result = getFreeTierNote(resourceType);
        expect(result).not.toBeNull();
        expect(result!.type).toBe("always_free");
        expect(result!.message).toBeTruthy();
      });
    }
  });

  // ── Usage-limited resources ─────────────────────────────────────────────────

  describe("usage-limited resources return { type: 'usage_limited' }", () => {
    const usageLimitedTypes = [
      "AWS::DynamoDB::Table",
      "AWS::Lambda::Function",
      "AWS::SQS::Queue",
      "AWS::SNS::Topic",
    ];

    for (const resourceType of usageLimitedTypes) {
      it(`returns usage_limited for ${resourceType}`, () => {
        const result = getFreeTierNote(resourceType);
        expect(result).not.toBeNull();
        expect(result!.type).toBe("usage_limited");
        expect(result!.message).toBeTruthy();
      });
    }
  });

  // ── Legacy-eligible resources ───────────────────────────────────────────────

  describe("legacy-eligible resources return { type: 'legacy_eligible' }", () => {
    const legacyTypes = ["AWS::EC2::Instance", "AWS::RDS::DBInstance"];

    for (const resourceType of legacyTypes) {
      it(`returns legacy_eligible for ${resourceType}`, () => {
        const result = getFreeTierNote(resourceType);
        expect(result).not.toBeNull();
        expect(result!.type).toBe("legacy_eligible");
        expect(result!.message).toContain("free tier eligible");
      });
    }
  });

  // ── Paid / unknown resources ────────────────────────────────────────────────

  describe("paid resources return null", () => {
    const paidTypes = [
      "AWS::EC2::NatGateway",
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
      "AWS::S3::Bucket",
      "AWS::Unknown::Resource",
    ];

    for (const resourceType of paidTypes) {
      it(`returns null for ${resourceType}`, () => {
        expect(getFreeTierNote(resourceType)).toBeNull();
      });
    }
  });

  // ── Regression guard: MCP adapter tracks core `getFreeTierMaps()` ──────────
  //
  // Story 58-it1-01 collapsed the 67-LOC MCP-side duplicate into a
  // shape-adapter over `getFreeTierMaps()` in core. These tests ensure the
  // adapter keeps deriving its categories from the single source of truth
  // — i.e., any always-free / usage-limited / legacy-eligible resource
  // added to core surfaces in MCP automatically with zero drift.

  describe("regression guard — MCP adapter reshapes core.getFreeTierMaps()", () => {
    it("exposes every core `alwaysFree` key as type='always_free'", () => {
      const { alwaysFree } = getFreeTierMaps();
      const keys = Object.keys(alwaysFree);
      expect(keys.length).toBeGreaterThan(0);
      for (const type of keys) {
        const info = getFreeTierNote(type);
        expect(info, `${type} should be always_free in MCP`).not.toBeNull();
        expect(info!.type).toBe("always_free");
        expect(info!.message).toBe(alwaysFree[type]);
      }
    });

    it("exposes every core `alwaysFreeWithLimits` key as type='usage_limited'", () => {
      const { alwaysFreeWithLimits } = getFreeTierMaps();
      const keys = Object.keys(alwaysFreeWithLimits);
      expect(keys.length).toBeGreaterThan(0);
      for (const type of keys) {
        const info = getFreeTierNote(type);
        expect(info, `${type} should be usage_limited in MCP`).not.toBeNull();
        expect(info!.type).toBe("usage_limited");
        // Message wraps the core-provided limits string.
        expect(info!.message).toContain(alwaysFreeWithLimits[type]);
      }
    });

    it("exposes every core `legacyEligible` key as type='legacy_eligible'", () => {
      const { legacyEligible } = getFreeTierMaps();
      const keys = Object.keys(legacyEligible);
      expect(keys.length).toBeGreaterThan(0);
      for (const type of keys) {
        const info = getFreeTierNote(type);
        expect(info, `${type} should be legacy_eligible in MCP`).not.toBeNull();
        expect(info!.type).toBe("legacy_eligible");
        // Preserves the "free tier eligible" wording the MCP tool response
        // contract has historically surfaced to consumers.
        expect(info!.message).toContain("free tier eligible");
        expect(info!.message).toContain(legacyEligible[type]);
      }
    });

    it("returns null for any resource type not in any core map", () => {
      const { alwaysFree, alwaysFreeWithLimits, legacyEligible } =
        getFreeTierMaps();
      const known = new Set([
        ...Object.keys(alwaysFree),
        ...Object.keys(alwaysFreeWithLimits),
        ...Object.keys(legacyEligible),
      ]);
      // A handful of known-paid types that must remain absent from every map.
      const paid = [
        "AWS::EC2::NatGateway",
        "AWS::ElasticLoadBalancingV2::LoadBalancer",
        "AWS::S3::Bucket",
      ];
      for (const type of paid) {
        expect(known.has(type)).toBe(false);
        expect(getFreeTierNote(type)).toBeNull();
      }
    });
  });
});
