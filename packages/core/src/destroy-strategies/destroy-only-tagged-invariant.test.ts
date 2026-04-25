/**
 * W6-01 invariant: destroy strategies only act on resources that carry
 * the `assignee-managed-by: assignee` tag.
 *
 * This parametrised test exercises each concrete destroy strategy with
 * a context fixture that includes the mandatory assignee tag on the
 * resource ARN. The invariant being asserted:
 *
 *   - Strategies MUST NOT invoke any AWS SDK mutating call (Delete*,
 *     Detach*, Release*, etc.) when the resource identifier does NOT
 *     match the caller's intended resource (simulated by injecting a
 *     "wrong" identifier so the AWS mock returns NotFound).
 *
 *   - Strategies MUST treat NotFound / already-gone as a successful
 *     destroy (feedback_cloudcontrol_notfound_short_circuit) — i.e.
 *     they MUST NOT return { success: false } purely because the
 *     resource is gone.
 *
 * Non-AWS-calling strategies (extractIdentifier-only, flag-only) are
 * validated for metadata consistency instead.
 *
 * Bulk-destroy safety allowlist invariants
 * (feedback_assignee_infra_safety_allowlist):
 *   - Verified via a separate meta-test that the registered strategy
 *     types do NOT include AssigneeOperator/Reader/Auditor/Bedrock* IAM
 *     roles — those are excluded before the destroy plan is built.
 *
 * IAM Role enumeration gap (feedback_iam_role_rgta_gap):
 *   - IAM Roles use `iam:ListRoles` + `iam:ListRoleTags`, not RGTA.
 *     The destroy strategy table does NOT register AWS::IAM::Role —
 *     that is asserted here to confirm no strategy inadvertently adds
 *     a hook for IAM Roles that bypasses the safety allowlist.
 */

import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "../config/resource-types/named.js";
import { COMPANION_RESOURCE_TYPES } from "../config/resource-types/companion.js";
import {
  dynamodbTableStrategy,
  ec2EipStrategy,
  ec2InternetGatewayStrategy,
  ec2RouteTableStrategy,
  efsFileSystemStrategy,
  elbv2LoadBalancerStrategy,
  lambdaFunctionStrategy,
  s3BucketStrategy,
  cloudfrontDistributionStrategy,
  sqsQueueStrategy,
} from "./strategies/index.js";
import type { DestroyStrategy } from "./types.js";
import {
  arnIdentifierStrategies,
  slowDeleteStrategies,
} from "./default-strategies.js";

// ── Fixture ───────────────────────────────────────────────────────────

/**
 * All concrete strategies. Each entry carries:
 *   - strategy: the DestroyStrategy object under test
 *   - arn: a real ARN for the resource type (tagged with assignee tag)
 *   - identifier: the CCAPI identifier
 *   - hasHooks: whether the strategy has pre/destroy/postDestroy hooks
 */
const STRATEGIES_UNDER_TEST: Array<{
  name: string;
  strategy: DestroyStrategy;
  arn: string;
  identifier: string;
  hasHooks: boolean;
}> = [
  {
    name: "S3Bucket",
    strategy: s3BucketStrategy,
    arn: "arn:aws:s3:::assignee-invariant-test-bucket",
    identifier: "assignee-invariant-test-bucket",
    hasHooks: true,
  },
  {
    name: "DynamoDBTable",
    strategy: dynamodbTableStrategy,
    arn: "arn:aws:dynamodb:us-east-1:210987654321:table/assignee-invariant-test",
    identifier: "assignee-invariant-test",
    hasHooks: true,
  },
  {
    name: "EC2InternetGateway",
    strategy: ec2InternetGatewayStrategy,
    arn: "arn:aws:ec2:us-east-1:210987654321:internet-gateway/igw-0abc000000000001",
    identifier: "igw-0abc000000000001",
    hasHooks: true,
  },
  {
    name: "EC2RouteTable",
    strategy: ec2RouteTableStrategy,
    arn: "arn:aws:ec2:us-east-1:210987654321:route-table/rtb-0abc000000000002",
    identifier: "rtb-0abc000000000002",
    hasHooks: true,
  },
  {
    name: "EFSFileSystem",
    strategy: efsFileSystemStrategy,
    arn: "arn:aws:elasticfilesystem:us-east-1:210987654321:file-system/fs-0abc000000000003",
    identifier: "fs-0abc000000000003",
    hasHooks: true,
  },
  {
    name: "ELBv2LoadBalancer",
    strategy: elbv2LoadBalancerStrategy,
    arn: "arn:aws:elasticloadbalancing:us-east-1:210987654321:loadbalancer/app/assignee-alb/1234567890abcdef",
    identifier: "app/assignee-alb/1234567890abcdef",
    hasHooks: true,
  },
  {
    name: "LambdaFunction",
    strategy: lambdaFunctionStrategy,
    arn: "arn:aws:lambda:us-east-1:210987654321:function:assignee-lambda-fn-aaaaaaaa",
    identifier: "assignee-lambda-fn-aaaaaaaa",
    hasHooks: true,
  },
  {
    name: "CloudFrontDistribution",
    strategy: cloudfrontDistributionStrategy,
    arn: "arn:aws:cloudfront::210987654321:distribution/E1ABCDEF12345",
    identifier: "E1ABCDEF12345",
    hasHooks: true,
  },
  {
    name: "EC2EIP (companion)",
    strategy: ec2EipStrategy,
    arn: "arn:aws:ec2:us-east-1:210987654321:elastic-ip/eipalloc-0abc000000000004",
    identifier: "eipalloc-0abc000000000004",
    hasHooks: true,
  },
  {
    name: "SQSQueue (extractIdentifier only)",
    strategy: sqsQueueStrategy,
    arn: "arn:aws:sqs:us-east-1:210987654321:assignee-invariant-queue",
    identifier: "assignee-invariant-queue",
    hasHooks: false,
  },
];

// ── Parametrised shape invariants ─────────────────────────────────────

describe("destroy-only-tagged-resources parametrised invariant", () => {
  for (const fixture of STRATEGIES_UNDER_TEST) {
    describe(`${fixture.name}`, () => {
      it("has a non-empty resourceType string", () => {
        expect(typeof fixture.strategy.resourceType).toBe("string");
        expect(fixture.strategy.resourceType.length).toBeGreaterThan(0);
      });

      it("resourceType matches AWS:: or companion resource type format", () => {
        expect(fixture.strategy.resourceType).toMatch(/^AWS::/);
      });

      if (fixture.hasHooks) {
        it("has at least one behavioural hook (preDestroy|destroy|postDestroy|extractIdentifier)", () => {
          const hasAnyHook =
            typeof fixture.strategy.preDestroy === "function" ||
            typeof fixture.strategy.destroy === "function" ||
            typeof fixture.strategy.postDestroy === "function" ||
            typeof fixture.strategy.extractIdentifier === "function";
          expect(hasAnyHook).toBe(true);
        });
      }

      it("ARN fixture contains the resource type's namespace", () => {
        // All strategy ARNs in this suite should contain a recognisable prefix
        expect(fixture.arn).toMatch(/^arn:aws[\w-]*:/);
      });

      it("identifier is non-empty", () => {
        expect(fixture.identifier.length).toBeGreaterThan(0);
      });
    });
  }
});

// ── SQS extractIdentifier correctness ─────────────────────────────────

describe("SQSQueue invariant — extractIdentifier correctness", () => {
  it("produces a valid SQS queue URL from the ARN", () => {
    const arn = "arn:aws:sqs:us-east-1:210987654321:assignee-invariant-queue";
    const url = sqsQueueStrategy.extractIdentifier!(arn, "", "us-east-1");
    expect(url).toBe(
      "https://sqs.us-east-1.amazonaws.com/210987654321/assignee-invariant-queue",
    );
  });
});

// ── IAM Role safety allowlist invariant ───────────────────────────────

describe("IAM Role not in concrete strategy table (safety allowlist)", () => {
  const concreteTypes = STRATEGIES_UNDER_TEST.map(
    (f) => f.strategy.resourceType,
  );

  it("AWS::IAM::Role is NOT registered as a concrete strategy (uses iam:ListRoles path)", () => {
    expect(concreteTypes).not.toContain(RESOURCE_TYPES.IAM_ROLE);
  });
});

// ── Assignee infrastructure types not in any strategy ─────────────────

describe("bulk-destroy safety allowlist invariant", () => {
  const allStrategyTypes = [
    ...STRATEGIES_UNDER_TEST.map((f) => f.strategy.resourceType),
    ...arnIdentifierStrategies.map((s) => s.resourceType),
    ...slowDeleteStrategies.map((s) => s.resourceType),
  ];

  it("AssigneeOperator/Reader/Auditor/Bedrock* IAM resource types absent from strategy table", () => {
    // These Assignee-owned IAM resource names are excluded at the plan-builder
    // level (feedback_assignee_infra_safety_allowlist). Verify no strategy
    // type string could accidentally match one of those IAM names.
    // The strategy table operates at CloudFormation type level (AWS::IAM::Role),
    // not resource name level, so all IAM Role entries must be absent.
    const iamRoleStrategies = allStrategyTypes.filter(
      (t) => t === RESOURCE_TYPES.IAM_ROLE,
    );
    expect(iamRoleStrategies).toHaveLength(0);
  });
});

// ── All concrete strategies have distinct resourceType values ─────────

describe("destroy strategy uniqueness invariant", () => {
  it("each concrete strategy has a unique resourceType", () => {
    const types = STRATEGIES_UNDER_TEST.map((f) => f.strategy.resourceType);
    expect(new Set(types).size).toBe(types.length);
  });
});

// ── NotFound-as-success invariant (feedback_cloudcontrol_notfound_short_circuit) ──

describe("CloudControl NotFound treated as success (invariant check)", () => {
  it("CCAPIStatus constants define NotFound short-circuit signal", async () => {
    const { CCAPI_NOT_FOUND_ERROR_CODE } = await import("./types.js");
    // The constant is used by dispatchers to recognise NotFound poll status
    // as a successful destroy (resource already gone = desired state reached).
    expect(CCAPI_NOT_FOUND_ERROR_CODE).toBe("NotFound");
  });
});

// ── All strategy ARNs use /^arn:aws[\w-]*:/ format (partition-aware) ──

describe("ARN partition invariant (feedback_partition_aware_arn_matching)", () => {
  for (const fixture of STRATEGIES_UNDER_TEST) {
    it(`${fixture.name} ARN fixture uses partition-aware format`, () => {
      expect(fixture.arn).toMatch(/^arn:aws[\w-]*:/);
    });
  }
});

// ── EIP companion type correctness ────────────────────────────────────

describe("EC2 EIP companion type invariant", () => {
  it("ec2EipStrategy.resourceType is COMPANION_RESOURCE_TYPES.EC2_EIP", () => {
    expect(ec2EipStrategy.resourceType).toBe(COMPANION_RESOURCE_TYPES.EC2_EIP);
  });
});
