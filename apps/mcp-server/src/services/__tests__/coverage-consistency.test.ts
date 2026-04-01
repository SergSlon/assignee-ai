/**
 * Cross-system consistency test — verifies keyword classification covers
 * all resource types and free tier maps align with pricing strategies.
 *
 * @see Story 40.6
 */

import { describe, it, expect } from "vitest";
import { SUPPORTED_TYPES_ARRAY } from "@assignee/core";
import { classifyResourceType } from "../cost-estimator.js";
import { getFreeTierNote } from "../free-tier.js";

// Map of each resource type to at least one keyword that should classify it
const TYPE_TO_KEYWORD: Record<string, string> = {
  "AWS::S3::Bucket": "s3 bucket",
  "AWS::SSM::Parameter": "ssm parameter",
  "AWS::IAM::Role": "iam role",
  "AWS::EC2::Instance": "ec2 instance",
  "AWS::RDS::DBInstance": "rds database",
  "AWS::Lambda::Function": "lambda function",
  "AWS::EC2::VPC": "vpc",
  "AWS::EC2::Subnet": "subnet",
  "AWS::EC2::SecurityGroup": "security group",
  "AWS::DynamoDB::Table": "dynamodb table",
  "AWS::SQS::Queue": "sqs queue",
  "AWS::SNS::Topic": "sns notification",
  "AWS::ElasticLoadBalancingV2::LoadBalancer": "load balancer",
  "AWS::ECS::Cluster": "ecs cluster",
  "AWS::ECR::Repository": "ecr repository",
  "AWS::Logs::LogGroup": "log group",
  "AWS::EC2::InternetGateway": "internet gateway",
  "AWS::EC2::RouteTable": "route table",
  "AWS::EC2::Route": "add a route",
  "AWS::EC2::NatGateway": "nat gateway",
  "AWS::ApiGatewayV2::Api": "api gateway",
  "AWS::CloudWatch::Alarm": "cloudwatch alarm",
  "AWS::SecretsManager::Secret": "secrets manager",
};

describe("cross-system consistency", () => {
  it("has keyword mapping for every supported type", () => {
    for (const type of SUPPORTED_TYPES_ARRAY) {
      expect(TYPE_TO_KEYWORD[type]).toBeDefined();
    }
  });

  describe("every resource type is classifiable by keyword", () => {
    for (const type of SUPPORTED_TYPES_ARRAY) {
      it(`classifies "${TYPE_TO_KEYWORD[type]}" as ${type}`, () => {
        const keyword = TYPE_TO_KEYWORD[type];
        expect(keyword).toBeDefined();
        expect(classifyResourceType(keyword!)).toBe(type);
      });
    }
  });

  describe("free tier consistency — always-free pricing strategies match free tier map", () => {
    // Resources we KNOW are always free from pricing strategies
    const KNOWN_FREE_TYPES = [
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

    for (const type of KNOWN_FREE_TYPES) {
      it(`${type} is in the free tier map`, () => {
        const note = getFreeTierNote(type);
        expect(note).not.toBeNull();
        expect(note!.type).toBe("always_free");
      });
    }
  });

  describe("legacy-eligible resources return legacy_eligible", () => {
    const LEGACY_TYPES = ["AWS::EC2::Instance", "AWS::RDS::DBInstance"];

    for (const type of LEGACY_TYPES) {
      it(`${type} returns legacy_eligible`, () => {
        const note = getFreeTierNote(type);
        expect(note).not.toBeNull();
        expect(note!.type).toBe("legacy_eligible");
      });
    }
  });

  describe("paid resources return null from free tier", () => {
    const KNOWN_PAID = [
      "AWS::EC2::NatGateway",
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
      "AWS::CloudWatch::Alarm",
      "AWS::SecretsManager::Secret",
      "AWS::ApiGatewayV2::Api",
      "AWS::Logs::LogGroup",
    ];

    for (const type of KNOWN_PAID) {
      it(`${type} returns null from free tier`, () => {
        expect(getFreeTierNote(type)).toBeNull();
      });
    }
  });
});
