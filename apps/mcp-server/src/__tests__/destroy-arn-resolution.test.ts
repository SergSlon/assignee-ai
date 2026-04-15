/**
 * ARN → CloudFormation resource type resolution tests for all 23 supported types.
 * Tests the real arnToResourceType and extractIdentifierFromArn from destroy-resource.ts.
 *
 * @see Story E2E.2 — AC2, AC4
 */

import { describe, it, expect } from "vitest";
import {
  arnToResourceType,
  extractIdentifierFromArn,
} from "../tools/destroy-resource.js";

describe("arnToResourceType — all 23 types", () => {
  const testCases: Array<{ name: string; arn: string; expected: string }> = [
    // Tier 0
    {
      name: "S3 Bucket",
      arn: "arn:aws:s3:::e2e-bucket-test",
      expected: "AWS::S3::Bucket",
    },
    {
      name: "SSM Parameter",
      arn: "arn:aws:ssm:us-east-1:123456789012:parameter/e2e-test/param",
      expected: "AWS::SSM::Parameter",
    },
    {
      name: "IAM Role",
      arn: "arn:aws:iam::123456789012:role/e2e-role-test",
      expected: "AWS::IAM::Role",
    },
    {
      name: "EC2 Instance",
      arn: "arn:aws:ec2:us-east-1:123456789012:instance/i-0123abc",
      expected: "AWS::EC2::Instance",
    },
    {
      name: "RDS DBInstance",
      arn: "arn:aws:rds:us-east-1:123456789012:db:e2e-rds-test",
      expected: "AWS::RDS::DBInstance",
    },
    {
      name: "Lambda Function",
      arn: "arn:aws:lambda:us-east-1:123456789012:function:e2e-fn",
      expected: "AWS::Lambda::Function",
    },

    // Tier 1 — Compound
    {
      name: "EC2 VPC",
      arn: "arn:aws:ec2:us-east-1:123456789012:vpc/vpc-0123abc",
      expected: "AWS::EC2::VPC",
    },
    {
      name: "EC2 Subnet",
      arn: "arn:aws:ec2:us-east-1:123456789012:subnet/subnet-0123",
      expected: "AWS::EC2::Subnet",
    },
    {
      name: "EC2 SecurityGroup",
      arn: "arn:aws:ec2:us-east-1:123456789012:security-group/sg-0123",
      expected: "AWS::EC2::SecurityGroup",
    },
    {
      name: "DynamoDB Table",
      arn: "arn:aws:dynamodb:us-east-1:123456789012:table/e2e-table",
      expected: "AWS::DynamoDB::Table",
    },
    {
      name: "SQS Queue",
      arn: "arn:aws:sqs:us-east-1:123456789012:e2e-queue",
      expected: "AWS::SQS::Queue",
    },
    {
      name: "SNS Topic",
      arn: "arn:aws:sns:us-east-1:123456789012:e2e-topic",
      expected: "AWS::SNS::Topic",
    },
    {
      name: "ELBv2 LoadBalancer",
      arn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-lb/abc123",
      expected: "AWS::ElasticLoadBalancingV2::LoadBalancer",
    },
    {
      name: "ECS Cluster",
      arn: "arn:aws:ecs:us-east-1:123456789012:cluster/e2e-cluster",
      expected: "AWS::ECS::Cluster",
    },
    {
      name: "ECR Repository",
      arn: "arn:aws:ecr:us-east-1:123456789012:repository/e2e-repo",
      expected: "AWS::ECR::Repository",
    },

    // Tier 1 — Networking
    {
      name: "EC2 InternetGateway",
      arn: "arn:aws:ec2:us-east-1:123456789012:internet-gateway/igw-0123",
      expected: "AWS::EC2::InternetGateway",
    },
    {
      name: "EC2 RouteTable",
      arn: "arn:aws:ec2:us-east-1:123456789012:route-table/rtb-0123",
      expected: "AWS::EC2::RouteTable",
    },
    {
      name: "EC2 NatGateway",
      arn: "arn:aws:ec2:us-east-1:123456789012:natgateway/nat-0123",
      expected: "AWS::EC2::NatGateway",
    },

    // Tier 1 — Observability
    {
      name: "CloudWatch LogGroup",
      arn: "arn:aws:logs:us-east-1:123456789012:log-group:/e2e/test",
      expected: "AWS::Logs::LogGroup",
    },

    // Tier 2
    {
      name: "CloudWatch Alarm",
      arn: "arn:aws:cloudwatch:us-east-1:123456789012:alarm:e2e-alarm",
      expected: "AWS::CloudWatch::Alarm",
    },
    {
      name: "SecretsManager Secret",
      arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:e2e-secret-AbCdEf",
      expected: "AWS::SecretsManager::Secret",
    },
    {
      name: "API Gateway V2 (apigateway)",
      arn: "arn:aws:apigateway:us-east-1::/apis/abc123",
      expected: "AWS::ApiGatewayV2::Api",
    },
    {
      name: "API Gateway V2 (execute-api)",
      arn: "arn:aws:execute-api:us-east-1:123456789012:abc123",
      expected: "AWS::ApiGatewayV2::Api",
    },
  ];

  for (const tc of testCases) {
    it(`resolves ${tc.name}: ${tc.arn}`, () => {
      expect(arnToResourceType(tc.arn)).toBe(tc.expected);
    });
  }

  describe("edge cases", () => {
    it("returns null for malformed ARN (too few parts)", () => {
      expect(arnToResourceType("arn:aws:s3")).toBeNull();
    });

    it("returns null for unknown service", () => {
      expect(
        arnToResourceType("arn:aws:unknown-service:us-east-1:123:resource/id"),
      ).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(arnToResourceType("")).toBeNull();
    });

    it("returns null for non-ARN identifier", () => {
      expect(arnToResourceType("my-bucket-name")).toBeNull();
    });

    it("handles Lambda EventSourceMapping ARN", () => {
      expect(
        arnToResourceType(
          "arn:aws:lambda:us-east-1:123:event-source-mapping:uuid-1234",
        ),
      ).toBe("AWS::Lambda::EventSourceMapping");
    });
  });
});

describe("extractIdentifierFromArn — correct identifiers for CloudControl", () => {
  it("S3 bucket (no slash)", () => {
    expect(extractIdentifierFromArn("arn:aws:s3:::my-bucket")).toBe(
      "my-bucket",
    );
  });

  it("EC2 instance (type/id)", () => {
    expect(
      extractIdentifierFromArn("arn:aws:ec2:us-east-1:123:instance/i-abc"),
    ).toBe("i-abc");
  });

  it("SSM parameter with hierarchical path preserves canonical leading slash", () => {
    // Wave 3 P2-2: the shared ARN helper in @assignee/core matches the
    // CLI's `resource-resolver.test.ts` contract — canonical SSM parameter
    // identifiers start with "/" because CloudControl's GetParameter/
    // PutParameter require the fully-qualified "/a/b/c" form. The previous
    // MCP inline impl stripped the leading "/", which would have caused
    // CCAPI DeleteResource to fail on nested parameters.
    expect(
      extractIdentifierFromArn(
        "arn:aws:ssm:us-east-1:123:parameter/app/config/db-url",
      ),
    ).toBe("/app/config/db-url");
  });

  it("LogGroup with path (including colons in ARN)", () => {
    expect(
      extractIdentifierFromArn(
        "arn:aws:logs:us-east-1:123:log-group:/aws/lambda/my-fn",
      ),
    ).toBe("/aws/lambda/my-fn");
  });

  it("LogGroup with simple name", () => {
    expect(
      extractIdentifierFromArn(
        "arn:aws:logs:us-east-1:123:log-group:my-log-group",
      ),
    ).toBe("my-log-group");
  });

  it("SQS queue (no slash separator)", () => {
    expect(extractIdentifierFromArn("arn:aws:sqs:us-east-1:123:my-queue")).toBe(
      "my-queue",
    );
  });

  it("SNS topic (no slash separator)", () => {
    expect(extractIdentifierFromArn("arn:aws:sns:us-east-1:123:my-topic")).toBe(
      "my-topic",
    );
  });

  it("SecretsManager with slash in name", () => {
    expect(
      extractIdentifierFromArn(
        "arn:aws:secretsmanager:us-east-1:123:secret:my-app/db-pass-AbCdEf",
      ),
    ).toBe("my-app/db-pass-AbCdEf");
  });

  it("CloudWatch alarm (colon separator)", () => {
    expect(
      extractIdentifierFromArn(
        "arn:aws:cloudwatch:us-east-1:123:alarm:my-alarm",
      ),
    ).toBe("my-alarm");
  });

  it("IAM role", () => {
    expect(extractIdentifierFromArn("arn:aws:iam::123:role/my-role")).toBe(
      "my-role",
    );
  });

  it("API Gateway V2", () => {
    expect(
      extractIdentifierFromArn("arn:aws:apigateway:us-east-1::/apis/abc123"),
    ).toBe("abc123");
  });

  it("falls back to full ARN for unrecognized format", () => {
    expect(extractIdentifierFromArn("not-an-arn")).toBe("not-an-arn");
  });
});
