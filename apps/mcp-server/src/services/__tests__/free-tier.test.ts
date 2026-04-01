/**
 * Tests for MCP free-tier.ts (Stories 40.2).
 * Verifies free tier note generation for always-free, usage-limited,
 * and paid resource types.
 */

import { describe, it, expect } from "vitest";
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

  // ── Paid / unknown resources ────────────────────────────────────────────────

  describe("paid resources return null", () => {
    const paidTypes = [
      "AWS::EC2::Instance",
      "AWS::RDS::DBInstance",
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
});
