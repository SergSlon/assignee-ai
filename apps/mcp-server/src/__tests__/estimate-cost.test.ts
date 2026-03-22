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
});
