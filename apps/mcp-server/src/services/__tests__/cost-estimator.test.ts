import { describe, it, expect } from "vitest";
import { classifyResourceType } from "../cost-estimator.js";

describe("classifyResourceType", () => {
  describe("all 23 resource types are reachable", () => {
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
});
