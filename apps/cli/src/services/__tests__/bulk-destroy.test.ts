import { describe, it, expect } from "vitest";
import {
  buildPlanFromResources,
  DESTROY_TIER,
  isAssigneeInfraResource,
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

  // Closes Phase 2 BUG-3: `destroy --all --include-iam` would have swept
  // the AssigneeOperatorPolicy / AssigneeReaderPolicy / AssigneeAuditor
  // Policy resources created by `assignee setup`, locking the user out
  // of every subsequent assignee command. The safety allowlist filters
  // these out unconditionally, even when --include-iam is passed.
  describe("assignee infrastructure safety allowlist", () => {
    const ASSIGNEE_OPERATOR_POLICY = res(
      "arn:aws:iam::054125018476:policy/AssigneeOperatorPolicy",
      "AWS::IAM::ManagedPolicy",
    );
    const ASSIGNEE_READER_POLICY = res(
      "arn:aws:iam::054125018476:policy/AssigneeReaderPolicy",
      "AWS::IAM::ManagedPolicy",
    );
    const ASSIGNEE_AUDITOR_POLICY = res(
      "arn:aws:iam::054125018476:policy/AssigneeAuditorPolicy",
      "AWS::IAM::ManagedPolicy",
    );
    const ASSIGNEE_BEDROCK_ROLE = res(
      "arn:aws:iam::054125018476:role/AssigneeAiBedrockLoggingRole",
      "AWS::IAM::Role",
    );
    const USER_IAM_ROLE = res(
      "arn:aws:iam::054125018476:role/my-app-execution-role",
      "AWS::IAM::Role",
    );

    it("isAssigneeInfraResource matches all 3 setup-created policies", () => {
      expect(isAssigneeInfraResource(ASSIGNEE_OPERATOR_POLICY.arn)).toBe(true);
      expect(isAssigneeInfraResource(ASSIGNEE_READER_POLICY.arn)).toBe(true);
      expect(isAssigneeInfraResource(ASSIGNEE_AUDITOR_POLICY.arn)).toBe(true);
    });

    it("isAssigneeInfraResource matches the AssigneeAi* role created by setup", () => {
      expect(isAssigneeInfraResource(ASSIGNEE_BEDROCK_ROLE.arn)).toBe(true);
    });

    it("isAssigneeInfraResource does NOT match user IAM resources", () => {
      expect(isAssigneeInfraResource(USER_IAM_ROLE.arn)).toBe(false);
      expect(
        isAssigneeInfraResource(
          "arn:aws:iam::054125018476:role/MyAssigneeOperatorPolicyClone",
        ),
      ).toBe(false);
      expect(
        isAssigneeInfraResource("arn:aws:iam::054125018476:role/lambda-exec"),
      ).toBe(false);
    });

    it("isAssigneeInfraResource does NOT match non-IAM ARNs", () => {
      expect(
        isAssigneeInfraResource("arn:aws:s3:::AssigneeOperatorPolicy"),
      ).toBe(false);
      expect(
        isAssigneeInfraResource(
          "arn:aws:lambda:us-east-1:054125018476:function:AssigneeReaderPolicy",
        ),
      ).toBe(false);
    });

    // Wave 10 P0-1: partition-blind allowlist let GovCloud / China users
    // self-lockout via `--include-iam` because the literal commercial-only
    // `arn:aws:iam::` prefix dropped through every non-commercial ARN.
    // The fix uses the `arn:aws[\w-]*:iam::` pattern that mirrors
    // arn-builder.ts isArn() — these tests pin the partition coverage so
    // a regression to the literal-prefix form fails CI.
    it("isAssigneeInfraResource matches GovCloud (aws-us-gov) infra ARNs", () => {
      expect(
        isAssigneeInfraResource(
          "arn:aws-us-gov:iam::054125018476:policy/AssigneeOperatorPolicy",
        ),
      ).toBe(true);
      expect(
        isAssigneeInfraResource(
          "arn:aws-us-gov:iam::054125018476:role/AssigneeAiBedrockLoggingRole",
        ),
      ).toBe(true);
    });

    it("isAssigneeInfraResource matches China (aws-cn) infra ARNs", () => {
      expect(
        isAssigneeInfraResource(
          "arn:aws-cn:iam::054125018476:policy/AssigneeReaderPolicy",
        ),
      ).toBe(true);
      expect(
        isAssigneeInfraResource(
          "arn:aws-cn:iam::054125018476:policy/AssigneeAuditorPolicy",
        ),
      ).toBe(true);
    });

    it("isAssigneeInfraResource still excludes user IAM roles in GovCloud / China", () => {
      expect(
        isAssigneeInfraResource(
          "arn:aws-us-gov:iam::054125018476:role/my-app-execution-role",
        ),
      ).toBe(false);
      expect(
        isAssigneeInfraResource(
          "arn:aws-cn:iam::054125018476:role/MyAssigneeOperatorPolicyClone",
        ),
      ).toBe(false);
    });

    it("excludes GovCloud assignee infra from --include-iam plan", () => {
      const govOperatorPolicy = res(
        "arn:aws-us-gov:iam::054125018476:policy/AssigneeOperatorPolicy",
        "AWS::IAM::ManagedPolicy",
      );
      const govUserRole = res(
        "arn:aws-us-gov:iam::054125018476:role/my-app-execution-role",
        "AWS::IAM::Role",
      );
      const plan = buildPlanFromResources([govOperatorPolicy, govUserRole], {
        includeIam: true,
      });

      const arns = plan.resources.map((r) => r.arn);
      expect(arns).not.toContain(govOperatorPolicy.arn);
      expect(arns).toContain(govUserRole.arn);
      expect(plan.excludedCount).toBe(1);
    });

    it("excludes AssigneeOperatorPolicy from --include-iam plan", () => {
      const input = [
        TIER2_LAMBDA,
        ASSIGNEE_OPERATOR_POLICY,
        ASSIGNEE_READER_POLICY,
        ASSIGNEE_AUDITOR_POLICY,
        USER_IAM_ROLE,
      ];
      const plan = buildPlanFromResources(input, { includeIam: true });

      const arns = plan.resources.map((r) => r.arn);
      expect(arns).not.toContain(ASSIGNEE_OPERATOR_POLICY.arn);
      expect(arns).not.toContain(ASSIGNEE_READER_POLICY.arn);
      expect(arns).not.toContain(ASSIGNEE_AUDITOR_POLICY.arn);
      // The user's own IAM role IS included.
      expect(arns).toContain(USER_IAM_ROLE.arn);
      // Lambda is included.
      expect(arns).toContain(TIER2_LAMBDA.arn);
      // 3 assignee infra policies excluded.
      expect(plan.excludedCount).toBe(3);
    });

    it("excludes AssigneeAi* role from --include-iam plan", () => {
      const input = [ASSIGNEE_BEDROCK_ROLE, USER_IAM_ROLE];
      const plan = buildPlanFromResources(input, { includeIam: true });

      const arns = plan.resources.map((r) => r.arn);
      expect(arns).not.toContain(ASSIGNEE_BEDROCK_ROLE.arn);
      expect(arns).toContain(USER_IAM_ROLE.arn);
    });

    it("excludes assignee infra policies even WITHOUT --include-iam", () => {
      // The IAM exclusion already filters them, but the safety allowlist
      // must take precedence so the order of filters does not matter
      // and a future refactor can't accidentally let them through.
      const input = [TIER5_S3, ASSIGNEE_OPERATOR_POLICY];
      const plan = buildPlanFromResources(input);

      expect(plan.resources.map((r) => r.arn)).not.toContain(
        ASSIGNEE_OPERATOR_POLICY.arn,
      );
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
    // Wave 11 P2-8: replaced the previous `expect(DESTROY_TIER[type])
    // .toBeDefined()` weak-assertion loop with a per-type tier equality
    // map. The previous version would have passed even if a type was
    // present with the wrong tier — e.g. if S3_BUCKET (tier 5) silently
    // got reordered to tier 1, the foundation-before-dependents
    // invariant would break and `assignee destroy --all` could try to
    // delete a bucket while a CloudFront distribution still pointed at
    // it. Pinning each type to its exact tier catches that immediately.
    //
    // Tier semantics (from DESTROY_TIER comment block in bulk-destroy.ts):
    //   1 = leaf / CDN — destroyed FIRST
    //   2 = service resources
    //   3 = compute / DB / network services
    //   4 = network infrastructure
    //   5 = foundations
    //   6 = identity (opt-in only) — destroyed LAST
    it("maps every core supported resource type to its expected destruction tier", () => {
      const expectedTiers: Record<string, number> = {
        // Tier 1 — leaf / CDN
        "AWS::EC2::Route": 1,
        "AWS::CloudWatch::Alarm": 1,
        "AWS::SecretsManager::Secret": 1,
        "AWS::Logs::LogGroup": 1,
        "AWS::SSM::Parameter": 1,
        "AWS::CloudFront::Distribution": 1,
        // Tier 2 — service resources
        "AWS::Lambda::Function": 2,
        "AWS::SQS::Queue": 2,
        "AWS::SNS::Topic": 2,
        "AWS::DynamoDB::Table": 2,
        "AWS::ApiGatewayV2::Api": 2,
        // Tier 3 — compute / DB / network services
        "AWS::EC2::Instance": 3,
        "AWS::RDS::DBInstance": 3,
        "AWS::ElasticLoadBalancingV2::LoadBalancer": 3,
        "AWS::EC2::NatGateway": 3,
        "AWS::ECR::Repository": 3,
        "AWS::ECS::Cluster": 3,
        // Tier 4 — network infrastructure
        "AWS::EC2::SecurityGroup": 4,
        "AWS::EC2::Subnet": 4,
        "AWS::EC2::InternetGateway": 4,
        "AWS::EC2::RouteTable": 4,
        // Tier 5 — foundations
        "AWS::S3::Bucket": 5,
        "AWS::EC2::VPC": 5,
        // Tier 6 — identity (opt-in only)
        "AWS::IAM::Role": 6,
        "AWS::IAM::ManagedPolicy": 6,
      };

      for (const [type, tier] of Object.entries(expectedTiers)) {
        expect(DESTROY_TIER[type]).toBe(tier);
      }
    });
  });
});
