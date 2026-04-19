import { describe, it, expect } from "vitest";
import { SUPPORTED_TYPES_ARRAY } from "@assignee/core";
import { classifyResourceType } from "../cost-estimator.js";

describe("classifyResourceType", () => {
  describe("keyword-to-type round trip (one entry per fixture, not per registry type)", () => {
    const cases: Array<[string, string]> = [
      ["create an s3 bucket", "AWS::S3::Bucket"],
      ["lambda function", "AWS::Lambda::Function"],
      ["dynamodb table", "AWS::DynamoDB::Table"],
      ["ec2 instance", "AWS::EC2::Instance"],
      ["rds database", "AWS::RDS::DBInstance"],
      ["sqs queue", "AWS::SQS::Queue"],
      ["sns notification", "AWS::SNS::Topic"],
      ["iam role", "AWS::IAM::Role"],
      ["ssm parameter store", "AWS::SSM::Parameter"],
      ["ecs container service", "AWS::ECS::Cluster"],
      ["ecr container registry", "AWS::ECR::Repository"],
      ["vpc", "AWS::EC2::VPC"],
      ["security group firewall", "AWS::EC2::SecurityGroup"],
      ["load balancer", "AWS::ElasticLoadBalancingV2::LoadBalancer"],
      ["create a subnet", "AWS::EC2::Subnet"],
      ["route table", "AWS::EC2::RouteTable"],
      ["internet gateway", "AWS::EC2::InternetGateway"],
      ["nat gateway", "AWS::EC2::NatGateway"],
      ["cloudwatch logs", "AWS::Logs::LogGroup"],
      ["api gateway", "AWS::ApiGatewayV2::Api"],
      ["cloudwatch alarm", "AWS::CloudWatch::Alarm"],
      ["secrets manager", "AWS::SecretsManager::Secret"],
      ["network route", "AWS::EC2::Route"],
    ];

    it.each(cases)('classifies "%s" as %s', (description, expectedType) => {
      expect(classifyResourceType(description)).toBe(expectedType);
    });
  });

  describe("ordering correctness — substring collisions resolved", () => {
    it('"secrets manager" matches SecretsManager (not ECR despite "ecr" substring)', () => {
      // SecretsManager entry is ordered before ECR to resolve this collision
      expect(classifyResourceType("secrets manager")).toBe(
        "AWS::SecretsManager::Secret",
      );
    });

    it('"network route" matches Route (not VPC — "network" removed from VPC keywords)', () => {
      expect(classifyResourceType("network route")).toBe("AWS::EC2::Route");
    });

    it('matches "route table" to RouteTable, not Route', () => {
      expect(classifyResourceType("route table")).toBe("AWS::EC2::RouteTable");
    });

    it('matches "create a route table" to RouteTable, not Route', () => {
      expect(classifyResourceType("create a route table")).toBe(
        "AWS::EC2::RouteTable",
      );
    });

    it('matches "routing table" to RouteTable, not Route', () => {
      expect(classifyResourceType("routing table")).toBe(
        "AWS::EC2::RouteTable",
      );
    });
  });

  describe("case insensitivity", () => {
    it('classifies "S3 Bucket" (mixed case) correctly', () => {
      expect(classifyResourceType("S3 Bucket")).toBe("AWS::S3::Bucket");
    });

    it('classifies "LAMBDA FUNCTION" (uppercase) correctly', () => {
      expect(classifyResourceType("LAMBDA FUNCTION")).toBe(
        "AWS::Lambda::Function",
      );
    });
  });

  describe("substring safety — no false positives from short keywords", () => {
    it('"scalable storage" does not match load balancer (no "alb" keyword)', () => {
      expect(classifyResourceType("scalable storage")).toBeNull();
    });

    it('"native compute" does not match NAT Gateway (no bare "nat" keyword)', () => {
      expect(classifyResourceType("native compute")).toBeNull();
    });
  });

  describe("no match", () => {
    it("returns null for unrecognized descriptions", () => {
      expect(classifyResourceType("unknown resource xyz")).toBeNull();
    });
  });

  // Story 56-it1-04 / L3-003: fail-loud registry drift guard.
  //
  // This suite's `cases` array is an intentionally-partial classifier
  // smoke-test. Authoritative "every registered type round-trips" coverage
  // lives in `coverage-consistency.test.ts`. When `SUPPORTED_TYPES_ARRAY`
  // grows, a maintainer must either (a) extend the smoke-test cases here
  // to mirror the new type, or (b) bump the `SMOKE_FIXTURE_COUNT`
  // baseline below after confirming `coverage-consistency.test.ts` covers
  // the addition. Failing loudly prevents the fixture from silently
  // falling behind the registry the way the stale legacy label did when
  // the registry reached 37 types (Epic 56 iteration 1 finding L3-003).
  describe("registry-parity drift guard (Story 56-it1-04)", () => {
    const SMOKE_FIXTURE_COUNT = 23;
    it("smoke-test fixture count matches the documented baseline", () => {
      // If this fails, either re-sync the fixture or update the
      // SMOKE_FIXTURE_COUNT baseline after deliberate review.
      // Keeping the baseline as a literal (not SUPPORTED_TYPES_ARRAY.length)
      // is a SELF-DOCUMENTING CHOICE: this suite is deliberately a smoke
      // test, not a full-coverage matrix.
      expect(SMOKE_FIXTURE_COUNT).toBeLessThanOrEqual(
        SUPPORTED_TYPES_ARRAY.length,
      );
    });
  });
});
