/**
 * End-to-end tests for the full estimate_cost pipeline (Epic 40).
 *
 * Exercises: keyword input -> classifyResourceType -> estimateCostForResource
 *            -> getFreeTierNote -> formatted CostEstimateResult
 *
 * Unlike the unit tests that test classifyResourceType and getFreeTierNote
 * independently, these tests verify the FULL flow for all 23 resource types.
 */

import { describe, it, expect } from "vitest";
import {
  classifyResourceType,
  estimateCostForResource,
  type CostEstimateResult,
} from "../cost-estimator.js";
import { getFreeTierNote } from "../free-tier.js";

// ── Data tables ─────────────────────────────────────────────────────────────

/** All 23 resource types with a representative keyword for classification. */
const ALL_RESOURCE_TYPES: Array<{
  keyword: string;
  expectedType: string;
  freeTierCategory:
    | "always_free"
    | "usage_limited"
    | "legacy_eligible"
    | "paid";
}> = [
  // Always free (9)
  {
    keyword: "iam role for the app",
    expectedType: "AWS::IAM::Role",
    freeTierCategory: "always_free",
  },
  {
    keyword: "ssm parameter for config",
    expectedType: "AWS::SSM::Parameter",
    freeTierCategory: "always_free",
  },
  {
    keyword: "vpc for production",
    expectedType: "AWS::EC2::VPC",
    freeTierCategory: "always_free",
  },
  {
    keyword: "private subnet for isolation",
    expectedType: "AWS::EC2::Subnet",
    freeTierCategory: "always_free",
  },
  {
    keyword: "security group for web",
    expectedType: "AWS::EC2::SecurityGroup",
    freeTierCategory: "always_free",
  },
  {
    keyword: "set up an internet gateway",
    expectedType: "AWS::EC2::InternetGateway",
    freeTierCategory: "always_free",
  },
  {
    keyword: "route table for traffic",
    expectedType: "AWS::EC2::RouteTable",
    freeTierCategory: "always_free",
  },
  {
    keyword: "network route for egress",
    expectedType: "AWS::EC2::Route",
    freeTierCategory: "always_free",
  },
  {
    keyword: "ecs cluster for containers",
    expectedType: "AWS::ECS::Cluster",
    freeTierCategory: "always_free",
  },

  // Usage-limited (4)
  {
    keyword: "dynamodb table for sessions",
    expectedType: "AWS::DynamoDB::Table",
    freeTierCategory: "usage_limited",
  },
  {
    keyword: "lambda function for processing",
    expectedType: "AWS::Lambda::Function",
    freeTierCategory: "usage_limited",
  },
  {
    keyword: "sqs queue for async jobs",
    expectedType: "AWS::SQS::Queue",
    freeTierCategory: "usage_limited",
  },
  {
    keyword: "sns topic for notifications",
    expectedType: "AWS::SNS::Topic",
    freeTierCategory: "usage_limited",
  },

  // Legacy eligible (2)
  {
    keyword: "ec2 instance for web server",
    expectedType: "AWS::EC2::Instance",
    freeTierCategory: "legacy_eligible",
  },
  {
    keyword: "rds database for the app",
    expectedType: "AWS::RDS::DBInstance",
    freeTierCategory: "legacy_eligible",
  },

  // Paid (8) — no free tier
  {
    keyword: "s3 bucket for assets",
    expectedType: "AWS::S3::Bucket",
    freeTierCategory: "paid",
  },
  {
    keyword: "application load balancer for frontend",
    expectedType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
    freeTierCategory: "paid",
  },
  {
    keyword: "ecr repository for images",
    expectedType: "AWS::ECR::Repository",
    freeTierCategory: "paid",
  },
  {
    keyword: "cloudwatch logs for the app",
    expectedType: "AWS::Logs::LogGroup",
    freeTierCategory: "paid",
  },
  {
    keyword: "nat gateway for outbound",
    expectedType: "AWS::EC2::NatGateway",
    freeTierCategory: "paid",
  },
  {
    keyword: "api gateway http api",
    expectedType: "AWS::ApiGatewayV2::Api",
    freeTierCategory: "paid",
  },
  {
    keyword: "cloudwatch alarm for cpu",
    expectedType: "AWS::CloudWatch::Alarm",
    freeTierCategory: "paid",
  },
  {
    keyword: "secrets manager for api keys",
    expectedType: "AWS::SecretsManager::Secret",
    freeTierCategory: "paid",
  },
];

// ── Full pipeline tests ─────────────────────────────────────────────────────

describe("estimate-cost E2E: keyword -> classify -> estimate -> free tier", () => {
  describe("full pipeline for all 23 resource types", () => {
    for (const {
      keyword,
      expectedType,
      freeTierCategory,
    } of ALL_RESOURCE_TYPES) {
      it(`${expectedType}: "${keyword}" -> classify -> estimate -> result`, () => {
        // Step 1: Classify keyword into resource type
        const classified = classifyResourceType(keyword);
        expect(classified).toBe(expectedType);

        // Step 2: Estimate cost (exercises pricing registry + free tier)
        const result = estimateCostForResource(classified!);
        expect(result).toBeDefined();
        expect(result.resourceType).toBe(expectedType);
        expect(typeof result.estimatedMonthlyCost).toBe("string");
        expect(result.estimatedMonthlyCost.length).toBeGreaterThan(0);

        // Step 3: Verify free tier integration matches category
        const freeTier = getFreeTierNote(classified!);

        if (freeTierCategory === "always_free") {
          expect(result.freeTierEligible).toBe(true);
          expect(result.freeTierNote).toBeDefined();
          // Always-free types show "$0.00 (always free)" when the pricing
          // strategy sets isFree=true, or "$0.00 (within free tier)" when
          // the pricing strategy has no price but free-tier info applies.
          expect(result.estimatedMonthlyCost).toMatch(
            /^\$0\.00 \((always free|within free tier)\)$/,
          );
          expect(freeTier).not.toBeNull();
          expect(freeTier!.type).toBe("always_free");
        } else if (freeTierCategory === "usage_limited") {
          expect(result.freeTierEligible).toBe(true);
          expect(result.freeTierNote).toBeDefined();
          expect(freeTier).not.toBeNull();
          expect(freeTier!.type).toBe("usage_limited");
        } else if (freeTierCategory === "legacy_eligible") {
          expect(result.freeTierEligible).toBe(true);
          expect(result.freeTierNote).toBeDefined();
          expect(freeTier).not.toBeNull();
          expect(freeTier!.type).toBe("legacy_eligible");
        } else {
          // Paid — no free tier
          expect(freeTier).toBeNull();
          expect(result.freeTierEligible).toBeUndefined();
          expect(result.freeTierNote).toBeUndefined();
        }
      });
    }
  });

  // ── Free tier consistency ───────────────────────────────────────────────────

  describe("free tier category consistency", () => {
    const alwaysFreeTypes = ALL_RESOURCE_TYPES.filter(
      (r) => r.freeTierCategory === "always_free",
    );
    const usageLimitedTypes = ALL_RESOURCE_TYPES.filter(
      (r) => r.freeTierCategory === "usage_limited",
    );
    const legacyTypes = ALL_RESOURCE_TYPES.filter(
      (r) => r.freeTierCategory === "legacy_eligible",
    );

    it("has exactly 9 always-free resource types", () => {
      expect(alwaysFreeTypes).toHaveLength(9);
    });

    it("has exactly 4 usage-limited resource types", () => {
      expect(usageLimitedTypes).toHaveLength(4);
    });

    it("has exactly 2 legacy-eligible resource types", () => {
      expect(legacyTypes).toHaveLength(2);
    });

    it("all always-free types return type='always_free' from getFreeTierNote", () => {
      for (const { expectedType } of alwaysFreeTypes) {
        const info = getFreeTierNote(expectedType);
        expect(
          info,
          `${expectedType} should have free tier info`,
        ).not.toBeNull();
        expect(info!.type).toBe("always_free");
      }
    });

    it("all usage-limited types return type='usage_limited' from getFreeTierNote", () => {
      for (const { expectedType } of usageLimitedTypes) {
        const info = getFreeTierNote(expectedType);
        expect(
          info,
          `${expectedType} should have free tier info`,
        ).not.toBeNull();
        expect(info!.type).toBe("usage_limited");
      }
    });

    it("all legacy-eligible types return type='legacy_eligible' from getFreeTierNote", () => {
      for (const { expectedType } of legacyTypes) {
        const info = getFreeTierNote(expectedType);
        expect(
          info,
          `${expectedType} should have free tier info`,
        ).not.toBeNull();
        expect(info!.type).toBe("legacy_eligible");
      }
    });

    it("covers all 23 supported resource types", () => {
      expect(ALL_RESOURCE_TYPES).toHaveLength(23);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("classifyResourceType with empty string returns null", () => {
      expect(classifyResourceType("")).toBeNull();
    });

    it("classifyResourceType with random unrelated text returns null", () => {
      expect(classifyResourceType("create something random")).toBeNull();
    });

    it("estimateCostForResource with unknown type does not crash", () => {
      const result = estimateCostForResource("AWS::Unknown::Widget");

      expect(result).toBeDefined();
      expect(result.resourceType).toBe("AWS::Unknown::Widget");
      expect(typeof result.estimatedMonthlyCost).toBe("string");
      expect(result.estimatedMonthlyCost.length).toBeGreaterThan(0);
      // Unknown types should not have free tier info
      expect(result.freeTierEligible).toBeUndefined();
      expect(result.freeTierNote).toBeUndefined();
    });

    it("estimateCostForResource with desiredState returns enriched estimate for EC2", () => {
      const result = estimateCostForResource("AWS::EC2::Instance", {
        InstanceType: "t3.micro",
      });

      expect(result).toBeDefined();
      expect(result.resourceType).toBe("AWS::EC2::Instance");
      expect(typeof result.estimatedMonthlyCost).toBe("string");
      expect(result.estimatedMonthlyCost.length).toBeGreaterThan(0);
      // EC2 is legacy_eligible so freeTierEligible should be true
      expect(result.freeTierEligible).toBe(true);
    });

    it("estimateCostForResource with desiredState returns enriched estimate for RDS", () => {
      const result = estimateCostForResource("AWS::RDS::DBInstance", {
        DBInstanceClass: "db.t3.micro",
        Engine: "postgres",
      });

      expect(result).toBeDefined();
      expect(result.resourceType).toBe("AWS::RDS::DBInstance");
      expect(typeof result.estimatedMonthlyCost).toBe("string");
      expect(result.estimatedMonthlyCost.length).toBeGreaterThan(0);
      // RDS is legacy_eligible
      expect(result.freeTierEligible).toBe(true);
    });

    it("estimateCostForResource with desiredState for Lambda includes free tier", () => {
      const result = estimateCostForResource("AWS::Lambda::Function", {
        MemorySize: 256,
        Timeout: 30,
      });

      expect(result.resourceType).toBe("AWS::Lambda::Function");
      expect(result.freeTierEligible).toBe(true);
      expect(result.freeTierNote).toContain("Lambda");
    });

    it("classifyResourceType is case-insensitive for all keywords", () => {
      expect(classifyResourceType("S3 BUCKET")).toBe("AWS::S3::Bucket");
      expect(classifyResourceType("LAMBDA function")).toBe(
        "AWS::Lambda::Function",
      );
      expect(classifyResourceType("DYNAMODB table")).toBe(
        "AWS::DynamoDB::Table",
      );
      expect(classifyResourceType("NAT GATEWAY")).toBe("AWS::EC2::NatGateway");
      expect(classifyResourceType("API GATEWAY HTTP API")).toBe(
        "AWS::ApiGatewayV2::Api",
      );
    });

    it("full pipeline handles classify-null gracefully", () => {
      const classified = classifyResourceType("something nobody knows");
      expect(classified).toBeNull();

      // If we proceed with null, the caller should handle it.
      // Verify estimateCostForResource still works with a fallback type.
      if (classified === null) {
        const result = estimateCostForResource("AWS::Unknown::Resource");
        expect(result).toBeDefined();
        expect(result.resourceType).toBe("AWS::Unknown::Resource");
      }
    });
  });
});
