import { describe, it, expect } from "vitest";
import {
  buildPlanFromResources,
  DESTROY_TIER,
  type BulkDestroyOptions,
} from "../bulk-destroy.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Shorthand for building a fake fetched resource. */
function res(
  arn: string,
  resourceType: string,
  region = "us-east-1",
): { arn: string; resourceType: string; region: string } {
  return { arn, resourceType, region };
}

// ── Real-world ARNs for each tier ───────────────────────────────────────────

const TIER1_ROUTE = res(
  "arn:aws:ec2:us-east-1:123456789012:route-table/rtb-abc123",
  "AWS::EC2::Route",
);
const TIER1_ALARM = res(
  "arn:aws:cloudwatch:us-east-1:123456789012:alarm:cpu-high",
  "AWS::CloudWatch::Alarm",
);
const TIER1_LOG_GROUP = res(
  "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/my-func",
  "AWS::Logs::LogGroup",
);
const TIER2_LAMBDA = res(
  "arn:aws:lambda:us-east-1:123456789012:function:my-func",
  "AWS::Lambda::Function",
);
const TIER2_SQS = res(
  "arn:aws:sqs:us-east-1:123456789012:my-queue",
  "AWS::SQS::Queue",
);
const TIER3_EC2 = res(
  "arn:aws:ec2:us-east-1:123456789012:instance/i-0abc123def456",
  "AWS::EC2::Instance",
);
const TIER3_RDS = res(
  "arn:aws:rds:us-east-1:123456789012:db:my-database",
  "AWS::RDS::DBInstance",
);
const TIER4_SG = res(
  "arn:aws:ec2:us-east-1:123456789012:security-group/sg-abc123",
  "AWS::EC2::SecurityGroup",
);
const TIER4_SUBNET = res(
  "arn:aws:ec2:us-east-1:123456789012:subnet/subnet-abc123",
  "AWS::EC2::Subnet",
);
const TIER5_S3 = res("arn:aws:s3:::my-app-bucket", "AWS::S3::Bucket");
const TIER5_VPC = res(
  "arn:aws:ec2:us-east-1:123456789012:vpc/vpc-abc123",
  "AWS::EC2::VPC",
);
const TIER6_IAM_ROLE = res(
  "arn:aws:iam::123456789012:role/my-lambda-role",
  "AWS::IAM::Role",
);
const TIER6_IAM_POLICY = res(
  "arn:aws:iam::123456789012:policy/my-custom-policy",
  "AWS::IAM::ManagedPolicy",
);

// ── Tests ───────────────────────────────────────────────────────────────────

describe("BulkDestroyService — buildPlanFromResources", () => {
  describe("tier ordering", () => {
    it("sorts resources by tier ascending (tier 1 first, tier 5 last when IAM excluded)", () => {
      const input = [TIER5_S3, TIER3_EC2, TIER1_ALARM, TIER4_SG, TIER2_LAMBDA];
      const plan = buildPlanFromResources(input);

      const tiers = plan.resources.map((r) => r.tier);
      expect(tiers).toEqual([1, 2, 3, 4, 5]);
    });

    it("places all tier 1 resources before tier 2, tier 2 before tier 3, etc.", () => {
      const input = [
        TIER4_SUBNET,
        TIER1_LOG_GROUP,
        TIER3_RDS,
        TIER2_SQS,
        TIER1_ALARM,
        TIER5_VPC,
        TIER3_EC2,
        TIER2_LAMBDA,
        TIER4_SG,
        TIER1_ROUTE,
        TIER5_S3,
      ];
      const plan = buildPlanFromResources(input);

      const tiers = plan.resources.map((r) => r.tier);
      // All tier 1s first, then tier 2s, etc.
      for (let i = 1; i < tiers.length; i++) {
        expect(tiers[i]).toBeGreaterThanOrEqual(tiers[i - 1]!);
      }
      // Verify all tiers present
      expect(new Set(tiers)).toEqual(new Set([1, 2, 3, 4, 5]));
    });
  });

  describe("IAM exclusion", () => {
    it("excludes IAM resources by default", () => {
      const input = [TIER2_LAMBDA, TIER6_IAM_ROLE, TIER6_IAM_POLICY, TIER5_S3];
      const plan = buildPlanFromResources(input);

      expect(plan.resources).toHaveLength(2);
      expect(plan.resources.map((r) => r.resourceType)).not.toContain(
        "AWS::IAM::Role",
      );
      expect(plan.resources.map((r) => r.resourceType)).not.toContain(
        "AWS::IAM::ManagedPolicy",
      );
      expect(plan.iamCount).toBe(2);
      expect(plan.excludedCount).toBe(2);
    });

    it("includes IAM resources when includeIam=true", () => {
      const input = [TIER2_LAMBDA, TIER6_IAM_ROLE, TIER6_IAM_POLICY, TIER5_S3];
      const plan = buildPlanFromResources(input, { includeIam: true });

      expect(plan.resources).toHaveLength(4);
      const types = plan.resources.map((r) => r.resourceType);
      expect(types).toContain("AWS::IAM::Role");
      expect(types).toContain("AWS::IAM::ManagedPolicy");
      expect(plan.iamCount).toBe(2);
      expect(plan.excludedCount).toBe(0);
    });

    it("IAM resources are placed in tier 6 (destroyed last) when included", () => {
      const input = [TIER6_IAM_ROLE, TIER1_ALARM, TIER5_S3];
      const plan = buildPlanFromResources(input, { includeIam: true });

      const lastResource = plan.resources[plan.resources.length - 1]!;
      expect(lastResource.tier).toBe(6);
      expect(lastResource.resourceType).toBe("AWS::IAM::Role");
    });
  });

  describe("pattern filtering", () => {
    it("filters resources by pattern matching against ARN", () => {
      const input = [TIER2_LAMBDA, TIER2_SQS, TIER5_S3];
      const plan = buildPlanFromResources(input, {
        pattern: /lambda/,
      });

      expect(plan.resources).toHaveLength(1);
      expect(plan.resources[0]!.resourceType).toBe("AWS::Lambda::Function");
      expect(plan.excludedCount).toBe(2);
    });

    it("filters resources by pattern matching against identifier", () => {
      const input = [TIER2_LAMBDA, TIER2_SQS, TIER5_S3];
      const plan = buildPlanFromResources(input, {
        pattern: /my-queue/,
      });

      expect(plan.resources).toHaveLength(1);
      expect(plan.resources[0]!.resourceType).toBe("AWS::SQS::Queue");
    });

    it("matches pattern against either ARN or identifier", () => {
      const input = [TIER5_S3, TIER3_EC2];
      // "my-app-bucket" is the identifier from the S3 ARN
      const plan = buildPlanFromResources(input, {
        pattern: /my-app-bucket/,
      });

      expect(plan.resources).toHaveLength(1);
      expect(plan.resources[0]!.resourceType).toBe("AWS::S3::Bucket");
    });
  });

  describe("region filtering", () => {
    it("filters resources by region", () => {
      const usEast = res(
        "arn:aws:lambda:us-east-1:123456789012:function:func-a",
        "AWS::Lambda::Function",
        "us-east-1",
      );
      const euWest = res(
        "arn:aws:lambda:eu-west-1:123456789012:function:func-b",
        "AWS::Lambda::Function",
        "eu-west-1",
      );
      const plan = buildPlanFromResources([usEast, euWest], {
        region: "eu-west-1",
      });

      expect(plan.resources).toHaveLength(1);
      expect(plan.resources[0]!.region).toBe("eu-west-1");
      expect(plan.excludedCount).toBe(1);
    });
  });

  describe("unknown resource type handling", () => {
    it("assigns default tier 3 for unknown resource types", () => {
      const unknown = res(
        "arn:aws:elasticache:us-east-1:123456789012:cluster:my-cache",
        "AWS::ElastiCache::CacheCluster",
      );
      const plan = buildPlanFromResources([unknown]);

      expect(plan.resources).toHaveLength(1);
      expect(plan.resources[0]!.tier).toBe(3);
    });

    it("sorts unknown-tier resources alongside tier 3 resources", () => {
      const unknown = res(
        "arn:aws:elasticache:us-east-1:123456789012:cluster:my-cache",
        "AWS::ElastiCache::CacheCluster",
      );
      const input = [TIER5_S3, unknown, TIER1_ALARM, TIER3_EC2];
      const plan = buildPlanFromResources(input);

      const tiers = plan.resources.map((r) => r.tier);
      expect(tiers).toEqual([1, 3, 3, 5]);
    });
  });

  describe("empty resource list", () => {
    it("returns an empty plan with zero counts", () => {
      const plan = buildPlanFromResources([]);

      expect(plan.resources).toEqual([]);
      expect(plan.totalCount).toBe(0);
      expect(plan.iamCount).toBe(0);
      expect(plan.excludedCount).toBe(0);
    });
  });

  describe("counts", () => {
    it("totalCount reflects all fetched resources before filtering", () => {
      const input = [TIER2_LAMBDA, TIER6_IAM_ROLE, TIER5_S3];
      const plan = buildPlanFromResources(input);

      expect(plan.totalCount).toBe(3);
      expect(plan.resources).toHaveLength(2); // IAM excluded
      expect(plan.iamCount).toBe(1);
      expect(plan.excludedCount).toBe(1);
    });

    it("counts IAM and pattern exclusions separately", () => {
      const input = [
        TIER2_LAMBDA,
        TIER6_IAM_ROLE,
        TIER6_IAM_POLICY,
        TIER5_S3,
        TIER3_EC2,
      ];
      // Exclude IAM (default) + pattern filters out S3
      const plan = buildPlanFromResources(input, {
        pattern: /lambda|instance/,
      });

      expect(plan.totalCount).toBe(5);
      expect(plan.resources).toHaveLength(2); // lambda + ec2
      expect(plan.iamCount).toBe(2);
      // 2 IAM excluded + 1 S3 excluded by pattern = 3
      expect(plan.excludedCount).toBe(3);
    });
  });

  describe("identifier extraction", () => {
    it("extracts function name from Lambda ARN", () => {
      const plan = buildPlanFromResources([TIER2_LAMBDA]);
      expect(plan.resources[0]!.identifier).toBe("my-func");
    });

    it("extracts bucket name from S3 ARN", () => {
      const plan = buildPlanFromResources([TIER5_S3]);
      expect(plan.resources[0]!.identifier).toBe("my-app-bucket");
    });

    it("extracts instance ID from EC2 ARN", () => {
      const plan = buildPlanFromResources([TIER3_EC2]);
      expect(plan.resources[0]!.identifier).toBe("i-0abc123def456");
    });

    it("extracts queue name from SQS ARN", () => {
      const plan = buildPlanFromResources([TIER2_SQS]);
      expect(plan.resources[0]!.identifier).toBe("my-queue");
    });

    it("extracts alarm name from CloudWatch ARN", () => {
      const plan = buildPlanFromResources([TIER1_ALARM]);
      expect(plan.resources[0]!.identifier).toBe("cpu-high");
    });

    it("extracts database name from RDS ARN", () => {
      const plan = buildPlanFromResources([TIER3_RDS]);
      expect(plan.resources[0]!.identifier).toBe("my-database");
    });
  });

  describe("DESTROY_TIER map completeness", () => {
    it("has entries for all core supported resource types", () => {
      const expectedTypes = [
        "AWS::EC2::Route",
        "AWS::CloudWatch::Alarm",
        "AWS::SecretsManager::Secret",
        "AWS::Logs::LogGroup",
        "AWS::SSM::Parameter",
        "AWS::Lambda::Function",
        "AWS::SQS::Queue",
        "AWS::SNS::Topic",
        "AWS::DynamoDB::Table",
        "AWS::ApiGatewayV2::Api",
        "AWS::EC2::Instance",
        "AWS::RDS::DBInstance",
        "AWS::ElasticLoadBalancingV2::LoadBalancer",
        "AWS::EC2::NatGateway",
        "AWS::ECR::Repository",
        "AWS::ECS::Cluster",
        "AWS::EC2::SecurityGroup",
        "AWS::EC2::Subnet",
        "AWS::EC2::InternetGateway",
        "AWS::EC2::RouteTable",
        "AWS::S3::Bucket",
        "AWS::EC2::VPC",
        "AWS::IAM::Role",
        "AWS::IAM::ManagedPolicy",
      ];

      for (const type of expectedTypes) {
        expect(DESTROY_TIER[type]).toBeDefined();
      }
    });
  });
});
