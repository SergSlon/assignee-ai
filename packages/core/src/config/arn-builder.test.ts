/**
 * Tests for buildResourceArn — converts CloudControl primary identifiers
 * into full AWS ARNs. Covers all entries in RESOURCE_TYPES.
 *
 * Closes Phase 2 smoke test BUG-5.
 */

import { describe, it, expect } from "vitest";
import { buildResourceArn, partitionForRegion, isArn } from "./arn-builder.js";
import { RESOURCE_TYPES } from "./resource-types.js";

const ACCOUNT = "112233445566";
const REGION = "us-east-1";

describe("partitionForRegion", () => {
  it("returns aws for commercial regions", () => {
    expect(partitionForRegion("us-east-1")).toBe("aws");
    expect(partitionForRegion("eu-west-1")).toBe("aws");
    expect(partitionForRegion("ap-southeast-2")).toBe("aws");
  });

  it("returns aws-us-gov for GovCloud regions", () => {
    expect(partitionForRegion("us-gov-east-1")).toBe("aws-us-gov");
    expect(partitionForRegion("us-gov-west-1")).toBe("aws-us-gov");
  });

  it("returns aws-cn for China regions", () => {
    expect(partitionForRegion("cn-north-1")).toBe("aws-cn");
    expect(partitionForRegion("cn-northwest-1")).toBe("aws-cn");
  });
});

describe("isArn", () => {
  it("accepts well-formed ARNs", () => {
    expect(isArn("arn:aws:s3:::my-bucket")).toBe(true);
    expect(isArn("arn:aws:iam::112233445566:role/my-role")).toBe(true);
    expect(isArn("arn:aws-us-gov:lambda:us-gov-east-1:123:function:fn")).toBe(
      true,
    );
    expect(isArn("arn:aws-cn:s3:::my-bucket")).toBe(true);
  });

  it("rejects bare identifiers", () => {
    expect(isArn("my-bucket")).toBe(false);
    expect(isArn("i-0123456789abcdef0")).toBe(false);
    expect(isArn("AssigneeOperatorPolicy")).toBe(false);
    expect(isArn("")).toBe(false);
  });

  it("rejects free-text fields that happen to contain 'arn:' substring", () => {
    expect(isArn("Description referencing arn:aws:s3:::foo")).toBe(false);
    expect(isArn(" arn:aws:s3:::leading-space")).toBe(false);
  });
});

describe("buildResourceArn", () => {
  describe("short-circuits when identifier is already an ARN", () => {
    it("returns the ARN unchanged for any resource type", () => {
      const preBuilt = "arn:aws:s3:::already-an-arn";
      const result = buildResourceArn({
        resourceType: RESOURCE_TYPES.S3_BUCKET,
        identifier: preBuilt,
        region: REGION,
        accountId: ACCOUNT,
      });
      expect(result).toBe(preBuilt);
    });

    it("preserves ELBv2 LoadBalancer ARN (CCAPI returns full ARN for this type)", () => {
      const arn =
        "arn:aws:elasticloadbalancing:us-east-1:112233445566:loadbalancer/app/my-alb/1234567890abcdef";
      const result = buildResourceArn({
        resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
        identifier: arn,
        region: REGION,
        accountId: ACCOUNT,
      });
      expect(result).toBe(arn);
    });
  });

  // Wave 11 P2-5: ELBv2/ECS/SNS branches assume CCAPI returned a full
  // ARN as the primary identifier (it always has, historically). If
  // CCAPI's response shape ever changes, the previous code silently
  // returned the bare identifier — corrupting billing MCP records and
  // user-visible apply success lines. The new behavior throws so the
  // failure surfaces immediately rather than leaking malformed values
  // downstream.
  describe("CCAPI-returns-ARN types fail loudly on bare identifiers", () => {
    it("throws when ELBv2 LoadBalancer is given a bare identifier", () => {
      expect(() =>
        buildResourceArn({
          resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
          identifier: "my-alb",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toThrow(/expected a full ARN as identifier/);
    });

    it("throws when ECS Cluster is given a bare identifier", () => {
      expect(() =>
        buildResourceArn({
          resourceType: RESOURCE_TYPES.ECS_CLUSTER,
          identifier: "my-cluster",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toThrow(/expected a full ARN as identifier/);
    });

    it("throws when SNS Topic is given a bare identifier", () => {
      expect(() =>
        buildResourceArn({
          resourceType: RESOURCE_TYPES.SNS_TOPIC,
          identifier: "my-topic",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toThrow(/expected a full ARN as identifier/);
    });

    it("ECS Cluster ARN passes through unchanged (existing CCAPI shape)", () => {
      const arn = "arn:aws:ecs:us-east-1:112233445566:cluster/my-cluster";
      const result = buildResourceArn({
        resourceType: RESOURCE_TYPES.ECS_CLUSTER,
        identifier: arn,
        region: REGION,
        accountId: ACCOUNT,
      });
      expect(result).toBe(arn);
    });

    it("SNS Topic ARN passes through unchanged (existing CCAPI shape)", () => {
      const arn = "arn:aws:sns:us-east-1:112233445566:my-topic";
      const result = buildResourceArn({
        resourceType: RESOURCE_TYPES.SNS_TOPIC,
        identifier: arn,
        region: REGION,
        accountId: ACCOUNT,
      });
      expect(result).toBe(arn);
    });
  });

  describe("global services", () => {
    it("S3 bucket — no region, no account", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.S3_BUCKET,
          identifier: "cli-ex-smoke-s3-1775586674",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:s3:::cli-ex-smoke-s3-1775586674");
    });

    it("IAM Role — no region, has account", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.IAM_ROLE,
          identifier: "cli-ex-iam-1775586358",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:iam::112233445566:role/cli-ex-iam-1775586358");
    });
  });

  describe("regional services with colon-separated identifier", () => {
    it("Lambda function", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
          identifier: "my-fn",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:lambda:us-east-1:112233445566:function:my-fn");
    });

    it("RDS DB instance", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
          identifier: "mydb",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:rds:us-east-1:112233445566:db:mydb");
    });

    it("SecretsManager Secret", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.SECRETSMANAGER_SECRET,
          identifier: "mysecret-aBcDef",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe(
        "arn:aws:secretsmanager:us-east-1:112233445566:secret:mysecret-aBcDef",
      );
    });

    it("CloudWatch alarm", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.CLOUDWATCH_ALARM,
          identifier: "high-cpu",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:cloudwatch:us-east-1:112233445566:alarm:high-cpu");
    });

    it("CloudWatch Logs log group with leading slash", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.LOGS_LOG_GROUP,
          identifier: "/aws/lambda/my-fn",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:logs:us-east-1:112233445566:log-group:/aws/lambda/my-fn");
    });
  });

  describe("regional services with slash-separated identifier", () => {
    it("DynamoDB table", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,
          identifier: "mytable",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:dynamodb:us-east-1:112233445566:table/mytable");
    });

    it("EC2 instance", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.EC2_INSTANCE,
          identifier: "i-0123456789abcdef0",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:ec2:us-east-1:112233445566:instance/i-0123456789abcdef0");
    });

    it("EC2 VPC", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.EC2_VPC,
          identifier: "vpc-0a1b2c3d",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:ec2:us-east-1:112233445566:vpc/vpc-0a1b2c3d");
    });

    it("EC2 Subnet", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.EC2_SUBNET,
          identifier: "subnet-0f1e2d3c",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:ec2:us-east-1:112233445566:subnet/subnet-0f1e2d3c");
    });

    it("EC2 Security Group", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.EC2_SECURITY_GROUP,
          identifier: "sg-0987654321",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:ec2:us-east-1:112233445566:security-group/sg-0987654321");
    });

    it("EC2 Internet Gateway", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
          identifier: "igw-05bfc1e2bde305134",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe(
        "arn:aws:ec2:us-east-1:112233445566:internet-gateway/igw-05bfc1e2bde305134",
      );
    });

    it("EC2 Route Table", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
          identifier: "rtb-0577c1b03ff7f0473",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe(
        "arn:aws:ec2:us-east-1:112233445566:route-table/rtb-0577c1b03ff7f0473",
      );
    });

    it("EC2 NAT Gateway", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.EC2_NAT_GATEWAY,
          identifier: "nat-0b337150b5f9b0b62",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe(
        "arn:aws:ec2:us-east-1:112233445566:natgateway/nat-0b337150b5f9b0b62",
      );
    });

    it("ECR repository", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.ECR_REPOSITORY,
          identifier: "my-app",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:ecr:us-east-1:112233445566:repository/my-app");
    });

    it("API Gateway v2 API", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.APIGATEWAYV2_API,
          identifier: "abc123",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:apigateway:us-east-1::/apis/abc123");
    });
  });

  describe("SQS queue", () => {
    it("parses CloudControl queue URL into an ARN", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.SQS_QUEUE,
          identifier:
            "https://sqs.us-east-1.amazonaws.com/112233445566/my-queue",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:sqs:us-east-1:112233445566:my-queue");
    });

    it("preserves region and account from the queue URL (not the args)", () => {
      // CCAPI returned a queue URL for a different region — the ARN
      // must reflect the URL, not the caller's default region.
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.SQS_QUEUE,
          identifier: "https://sqs.eu-west-1.amazonaws.com/999888777666/q2",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:sqs:eu-west-1:999888777666:q2");
    });

    it("falls back to args when the identifier is a bare queue name", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.SQS_QUEUE,
          identifier: "bare-queue-name",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:sqs:us-east-1:112233445566:bare-queue-name");
    });
  });

  describe("SSM Parameter", () => {
    it("strips leading slash and builds parameter/ path", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.SSM_PARAMETER,
          identifier: "/app/db/host",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:ssm:us-east-1:112233445566:parameter/app/db/host");
    });

    it("handles identifier without leading slash", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.SSM_PARAMETER,
          identifier: "app/db/host",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:ssm:us-east-1:112233445566:parameter/app/db/host");
    });
  });

  describe("non-ARN-addressable types", () => {
    it("EC2 Route returns the identifier unchanged", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.EC2_ROUTE,
          identifier: "rtb-abc|0.0.0.0/0",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("rtb-abc|0.0.0.0/0");
    });

    it("EC2 VPCGatewayAttachment returns the identifier unchanged", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT,
          identifier: "IGW|vpc-0712644090346eb2b",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("IGW|vpc-0712644090346eb2b");
    });

    // (f) 2026-04-09 Task 4b: OAC + BucketPolicy pass-through. Neither
    // needs a full ARN synthesized — downstream consumers reference
    // OAC by bare Id (CloudFront DistributionConfig.Origins[].
    // OriginAccessControlId) and BucketPolicy by bucket name
    // (the policy IS the bucket's attribute).
    it("CloudFront OriginAccessControl returns the bare Id unchanged", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.CLOUDFRONT_ORIGIN_ACCESS_CONTROL,
          identifier: "E1ABCDEFG12345",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("E1ABCDEFG12345");
    });

    it("S3 BucketPolicy returns the bucket name unchanged", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.S3_BUCKET_POLICY,
          identifier: "my-static-site-bucket",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("my-static-site-bucket");
    });
  });

  // (f) 2026-04-09 Task 4b: CloudFront is a global service so the
  // ARN has no region segment; the distribution Id is the CCAPI
  // primaryIdentifier and we synthesize the account-scoped ARN for
  // compound pattern marker resolution.
  describe("CloudFront Distribution (global, account-scoped ARN)", () => {
    it("synthesizes the canonical account-scoped distribution ARN", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
          identifier: "E1ABCDEFG12345",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws:cloudfront::112233445566:distribution/E1ABCDEFG12345");
    });

    it("uses the aws-us-gov partition for GovCloud callers", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
          identifier: "E1ABCDEFG12345",
          region: "us-gov-east-1",
          accountId: ACCOUNT,
        }),
      ).toBe(
        "arn:aws-us-gov:cloudfront::112233445566:distribution/E1ABCDEFG12345",
      );
    });
  });

  describe("partition handling", () => {
    it("uses aws-us-gov partition for GovCloud regions", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
          identifier: "my-fn",
          region: "us-gov-east-1",
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws-us-gov:lambda:us-gov-east-1:112233445566:function:my-fn");
    });

    it("uses aws-cn partition for China regions", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.S3_BUCKET,
          identifier: "my-bucket",
          region: "cn-north-1",
          accountId: ACCOUNT,
        }),
      ).toBe("arn:aws-cn:s3:::my-bucket");
    });

    it("explicit partition override takes precedence", () => {
      expect(
        buildResourceArn({
          resourceType: RESOURCE_TYPES.IAM_ROLE,
          identifier: "my-role",
          region: "us-east-1",
          accountId: ACCOUNT,
          partition: "aws-us-gov",
        }),
      ).toBe("arn:aws-us-gov:iam::112233445566:role/my-role");
    });
  });

  describe("unknown resource types", () => {
    it("returns the identifier verbatim for unknown types", () => {
      expect(
        buildResourceArn({
          resourceType: "AWS::NewService::NewResource",
          identifier: "some-id",
          region: REGION,
          accountId: ACCOUNT,
        }),
      ).toBe("some-id");
    });
  });
});
