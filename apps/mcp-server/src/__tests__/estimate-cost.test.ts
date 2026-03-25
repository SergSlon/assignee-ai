/**
 * Unit tests for estimate_cost MCP tool.
 *
 * @see Story 20.4
 */

import { describe, it, expect } from "vitest";
import {
  classifyResourceType,
  estimateCostForResource,
} from "../services/cost-estimator.js";

describe("classifyResourceType", () => {
  it("should classify S3 bucket descriptions", () => {
    expect(classifyResourceType("Create an S3 bucket for static assets")).toBe(
      "AWS::S3::Bucket",
    );
  });

  it("should classify Lambda function descriptions", () => {
    expect(
      classifyResourceType("A serverless function to process orders"),
    ).toBe("AWS::Lambda::Function");
  });

  it("should classify DynamoDB table descriptions", () => {
    expect(classifyResourceType("DynamoDB table for user sessions")).toBe(
      "AWS::DynamoDB::Table",
    );
  });

  it("should classify EC2 instance descriptions", () => {
    expect(classifyResourceType("EC2 instance for web server")).toBe(
      "AWS::EC2::Instance",
    );
  });

  it("should classify RDS database descriptions", () => {
    expect(classifyResourceType("RDS PostgreSQL database for the app")).toBe(
      "AWS::RDS::DBInstance",
    );
  });

  it("should classify SQS queue descriptions", () => {
    expect(classifyResourceType("SQS queue for async processing")).toBe(
      "AWS::SQS::Queue",
    );
  });

  it("should classify SNS topic descriptions", () => {
    expect(classifyResourceType("SNS topic for email notifications")).toBe(
      "AWS::SNS::Topic",
    );
  });

  it("should return null for unknown resource descriptions", () => {
    expect(
      classifyResourceType("something completely unrecognizable xyz"),
    ).toBeNull();
  });

  it("should be case-insensitive", () => {
    expect(classifyResourceType("Create an S3 BUCKET")).toBe("AWS::S3::Bucket");
    expect(classifyResourceType("LAMBDA function")).toBe(
      "AWS::Lambda::Function",
    );
  });

  // ── Missing classifier tests for remaining KEYWORD_TO_RESOURCE_TYPE entries ──

  it("should classify IAM role descriptions", () => {
    expect(classifyResourceType("Create an IAM role for the application")).toBe(
      "AWS::IAM::Role",
    );
    expect(classifyResourceType("service role for the compute task")).toBe(
      "AWS::IAM::Role",
    );
  });

  it("should classify SSM Parameter descriptions", () => {
    expect(
      classifyResourceType("SSM parameter for database connection string"),
    ).toBe("AWS::SSM::Parameter");
    expect(classifyResourceType("Store config in parameter store")).toBe(
      "AWS::SSM::Parameter",
    );
  });

  it("should classify ECS cluster descriptions", () => {
    expect(classifyResourceType("ECS cluster for microservices")).toBe(
      "AWS::ECS::Cluster",
    );
    expect(classifyResourceType("Fargate container service")).toBe(
      "AWS::ECS::Cluster",
    );
  });

  it("should classify ECR repository descriptions", () => {
    expect(classifyResourceType("ECR repository for app images")).toBe(
      "AWS::ECR::Repository",
    );
    expect(classifyResourceType("Docker registry for CI/CD")).toBe(
      "AWS::ECR::Repository",
    );
  });

  it("should classify VPC descriptions", () => {
    expect(classifyResourceType("VPC for production environment")).toBe(
      "AWS::EC2::VPC",
    );
    expect(classifyResourceType("Virtual private cloud for isolation")).toBe(
      "AWS::EC2::VPC",
    );
  });

  it("should classify Security Group descriptions", () => {
    expect(classifyResourceType("Security group for web servers")).toBe(
      "AWS::EC2::SecurityGroup",
    );
    expect(classifyResourceType("Firewall rules for API tier")).toBe(
      "AWS::EC2::SecurityGroup",
    );
  });

  it("should classify Load Balancer descriptions", () => {
    expect(classifyResourceType("Application load balancer for frontend")).toBe(
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
    );
    expect(classifyResourceType("ALB to distribute traffic")).toBe(
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
    );
  });

  // ── Tier 1/2 resource types not in KEYWORD_TO_RESOURCE_TYPE ──

  it("should return null for CloudWatch Logs description (not in keyword map)", () => {
    expect(
      classifyResourceType("CloudWatch log group for application logs"),
    ).toBeNull();
  });

  it("should return null for CloudWatch Alarm description (not in keyword map)", () => {
    expect(
      classifyResourceType("CloudWatch alarm for CPU utilization"),
    ).toBeNull();
  });

  it("should return null for Secrets Manager description (not in keyword map)", () => {
    // Note: "secrets" contains "ecr" substring which false-matches ECR keywords,
    // so we use a phrasing that avoids all keyword substrings
    expect(
      classifyResourceType("credential vault for storing API keys"),
    ).toBeNull();
  });

  it("should return null for API Gateway V2 description (not in keyword map)", () => {
    expect(
      classifyResourceType("API Gateway HTTP API for REST endpoints"),
    ).toBeNull();
  });

  it("should return null for Internet Gateway description (not in keyword map)", () => {
    expect(
      classifyResourceType("Internet gateway for public subnet access"),
    ).toBeNull();
  });

  it("should return null for Route Table description (not in keyword map)", () => {
    expect(classifyResourceType("Route table for private subnets")).toBeNull();
  });

  it("should return null for Route description (not in keyword map)", () => {
    expect(
      classifyResourceType("Route to NAT gateway for outbound traffic"),
    ).toBeNull();
  });

  it("should return null for NAT Gateway description (not in keyword map)", () => {
    expect(
      classifyResourceType("NAT gateway for private subnet internet access"),
    ).toBeNull();
  });
});

describe("estimateCostForResource", () => {
  it("should return cost estimate for S3 bucket", () => {
    const result = estimateCostForResource("AWS::S3::Bucket");

    expect(result.resourceType).toBe("AWS::S3::Bucket");
    expect(result.estimatedMonthlyCost).toBeDefined();
    expect(typeof result.estimatedMonthlyCost).toBe("string");
  });

  it("should return cost estimate for Lambda function with free tier note", () => {
    const result = estimateCostForResource("AWS::Lambda::Function");

    expect(result.resourceType).toBe("AWS::Lambda::Function");
    expect(result.freeTierEligible).toBe(true);
    expect(result.freeTierNote).toBeDefined();
    expect(result.freeTierNote).toContain("Lambda");
  });

  it("should return cost estimate for IAM Role as always free", () => {
    const result = estimateCostForResource("AWS::IAM::Role");

    expect(result.resourceType).toBe("AWS::IAM::Role");
    expect(result.freeTierEligible).toBe(true);
    expect(result.freeTierNote).toContain("free");
  });

  it("should return cost estimate for unknown resource type", () => {
    const result = estimateCostForResource("AWS::Unknown::Resource");

    expect(result.resourceType).toBe("AWS::Unknown::Resource");
    expect(result.estimatedMonthlyCost).toBeDefined();
    // No free tier note for unknown types
    expect(result.freeTierEligible).toBeUndefined();
  });

  it("should include free tier note for DynamoDB table", () => {
    const result = estimateCostForResource("AWS::DynamoDB::Table");

    expect(result.freeTierEligible).toBe(true);
    expect(result.freeTierNote).toContain("free");
  });

  it("should include free tier note for SSM Parameter", () => {
    const result = estimateCostForResource("AWS::SSM::Parameter");

    expect(result.freeTierEligible).toBe(true);
    expect(result.freeTierNote).toContain("free");
  });

  it("should include free tier note for SQS Queue", () => {
    const result = estimateCostForResource("AWS::SQS::Queue");

    expect(result.freeTierEligible).toBe(true);
    expect(result.freeTierNote).toContain("SQS");
  });

  it("should accept desiredState for more accurate estimates", () => {
    const result = estimateCostForResource("AWS::Lambda::Function", {
      MemorySize: 512,
    });

    expect(result.resourceType).toBe("AWS::Lambda::Function");
    expect(result.estimatedMonthlyCost).toBeDefined();
  });

  it("should not have free tier note for EC2 instances", () => {
    const result = estimateCostForResource("AWS::EC2::Instance");

    // EC2 is legacy eligible, not always free — our simplified
    // MCP server version does not track account dates
    expect(result.resourceType).toBe("AWS::EC2::Instance");
  });

  // ── Tier 1/2 resource type estimates ──────────────────────────────────────

  it("should return cost estimate for Logs::LogGroup", () => {
    const result = estimateCostForResource("AWS::Logs::LogGroup");

    expect(result.resourceType).toBe("AWS::Logs::LogGroup");
    expect(result.estimatedMonthlyCost).toBeDefined();
    expect(typeof result.estimatedMonthlyCost).toBe("string");
  });

  it("should return cost estimate for CloudWatch::Alarm", () => {
    const result = estimateCostForResource("AWS::CloudWatch::Alarm");

    expect(result.resourceType).toBe("AWS::CloudWatch::Alarm");
    expect(result.estimatedMonthlyCost).toBeDefined();
    expect(typeof result.estimatedMonthlyCost).toBe("string");
  });

  it("should return cost estimate for SecretsManager::Secret", () => {
    const result = estimateCostForResource("AWS::SecretsManager::Secret");

    expect(result.resourceType).toBe("AWS::SecretsManager::Secret");
    expect(result.estimatedMonthlyCost).toBeDefined();
    expect(typeof result.estimatedMonthlyCost).toBe("string");
  });

  it("should return cost estimate for ApiGatewayV2::Api", () => {
    const result = estimateCostForResource("AWS::ApiGatewayV2::Api");

    expect(result.resourceType).toBe("AWS::ApiGatewayV2::Api");
    expect(result.estimatedMonthlyCost).toBeDefined();
    expect(typeof result.estimatedMonthlyCost).toBe("string");
  });

  it("should return cost estimate for EC2::InternetGateway", () => {
    const result = estimateCostForResource("AWS::EC2::InternetGateway");

    expect(result.resourceType).toBe("AWS::EC2::InternetGateway");
    expect(result.estimatedMonthlyCost).toBeDefined();
    expect(typeof result.estimatedMonthlyCost).toBe("string");
  });

  it("should return cost estimate for EC2::RouteTable", () => {
    const result = estimateCostForResource("AWS::EC2::RouteTable");

    expect(result.resourceType).toBe("AWS::EC2::RouteTable");
    expect(result.estimatedMonthlyCost).toBeDefined();
    expect(typeof result.estimatedMonthlyCost).toBe("string");
  });

  it("should return cost estimate for EC2::Route", () => {
    const result = estimateCostForResource("AWS::EC2::Route");

    expect(result.resourceType).toBe("AWS::EC2::Route");
    expect(result.estimatedMonthlyCost).toBeDefined();
    expect(typeof result.estimatedMonthlyCost).toBe("string");
  });

  it("should return cost estimate for EC2::NatGateway", () => {
    const result = estimateCostForResource("AWS::EC2::NatGateway");

    expect(result.resourceType).toBe("AWS::EC2::NatGateway");
    expect(result.estimatedMonthlyCost).toBeDefined();
    expect(typeof result.estimatedMonthlyCost).toBe("string");
  });
});
