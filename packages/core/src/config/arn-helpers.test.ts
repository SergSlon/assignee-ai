/**
 * Tests for shared ARN parsing helpers (Wave 3 P2-2).
 *
 * These helpers power both the CLI `resource-resolver.ts` resolver and
 * the MCP server `destroy-resource.ts` tool. The test matrix covers all
 * 5 published AWS partitions (`aws`, `aws-cn`, `aws-us-gov`, `aws-iso`,
 * `aws-iso-b`) plus the structural edge cases that used to diverge
 * between the two inline copies (SSM leading slash, log-group ARN with
 * embedded colons, SQS queue URL synthesis, ARN-identified resource
 * types).
 */

import { describe, it, expect } from "vitest";
import { isArn } from "./arn-builder.js";
import {
  arnToResourceType,
  extractIdentifierFromArn,
  extractRegionFromArn,
  extractAccountIdFromArn,
  getCloudControlIdentifier,
  ARN_IDENTIFIED_RESOURCE_TYPES,
} from "./arn-helpers.js";
import { RESOURCE_TYPES, LIST_RESOURCE_TYPES } from "./resource-types.js";

// Same resource, five partitions — so every helper is verified against
// GovCloud, China, and both ISO variants, not just commercial.
const PARTITIONS = [
  { name: "aws", prefix: "aws" },
  { name: "aws-cn", prefix: "aws-cn" },
  { name: "aws-us-gov", prefix: "aws-us-gov" },
  { name: "aws-iso", prefix: "aws-iso" },
  { name: "aws-iso-b", prefix: "aws-iso-b" },
] as const;

describe("isArn (partition-aware)", () => {
  for (const { name, prefix } of PARTITIONS) {
    it(`accepts ${name} partition`, () => {
      expect(isArn(`arn:${prefix}:s3:::my-bucket`)).toBe(true);
    });
  }

  it("rejects bare names", () => {
    expect(isArn("my-bucket")).toBe(false);
  });

  it("rejects SQS queue URLs", () => {
    expect(isArn("https://sqs.us-east-1.amazonaws.com/123/queue")).toBe(false);
  });

  it("rejects empty strings", () => {
    expect(isArn("")).toBe(false);
  });

  it("rejects malformed 'arn:' prefixes without a partition", () => {
    expect(isArn("arn::s3:::bucket")).toBe(false);
  });
});

describe("arnToResourceType (partition-aware)", () => {
  for (const { name, prefix } of PARTITIONS) {
    describe(`partition ${name}`, () => {
      it("resolves S3 bucket", () => {
        expect(arnToResourceType(`arn:${prefix}:s3:::my-bucket`)).toBe(
          RESOURCE_TYPES.S3_BUCKET,
        );
      });

      it("resolves EC2 VPC via subtype map", () => {
        expect(
          arnToResourceType(`arn:${prefix}:ec2:us-east-1:123:vpc/vpc-abc`),
        ).toBe(RESOURCE_TYPES.EC2_VPC);
      });

      it("resolves IAM Role via subtype map", () => {
        expect(arnToResourceType(`arn:${prefix}:iam::123:role/my-role`)).toBe(
          RESOURCE_TYPES.IAM_ROLE,
        );
      });

      it("resolves Lambda function via default subtype ''", () => {
        expect(
          arnToResourceType(
            `arn:${prefix}:lambda:us-east-1:123:function:my-fn`,
          ),
        ).toBe(RESOURCE_TYPES.LAMBDA_FUNCTION);
      });

      it("resolves SNS Topic via simple map", () => {
        expect(arnToResourceType(`arn:${prefix}:sns:us-east-1:123:topic`)).toBe(
          RESOURCE_TYPES.SNS_TOPIC,
        );
      });
    });
  }

  it("returns null for unknown services", () => {
    expect(
      arnToResourceType("arn:aws:unknown-service:us-east-1:123:foo"),
    ).toBeNull();
  });

  it("returns null for malformed ARN (< 6 segments)", () => {
    expect(arnToResourceType("arn:aws:s3")).toBeNull();
  });

  it("returns null for bare names", () => {
    expect(arnToResourceType("my-bucket")).toBeNull();
  });

  it("returns null for EC2 subtype not in map", () => {
    // The subtype map returns null when no match — "flow-log" isn't in ec2 subtypes.
    expect(
      arnToResourceType("arn:aws:ec2:us-east-1:123:flow-log/fl-abc"),
    ).toBeNull();
  });

  it("resolves apigateway /apis path (subtype slash-prefix)", () => {
    expect(
      arnToResourceType("arn:aws:apigateway:us-east-1::/apis/abc123"),
    ).toBe(RESOURCE_TYPES.APIGATEWAYV2_API);
  });

  it("resolves IAM user via subtype", () => {
    expect(arnToResourceType("arn:aws:iam::123:user/alice")).toBe(
      LIST_RESOURCE_TYPES.IAM_USER,
    );
  });
});

describe("extractIdentifierFromArn", () => {
  for (const { name, prefix } of PARTITIONS) {
    it(`extracts S3 bucket name on ${name}`, () => {
      expect(extractIdentifierFromArn(`arn:${prefix}:s3:::my-bucket`)).toBe(
        "my-bucket",
      );
    });
  }

  it("extracts EC2 instance id (slash-separated)", () => {
    expect(
      extractIdentifierFromArn("arn:aws:ec2:us-east-1:123:instance/i-abc"),
    ).toBe("i-abc");
  });

  it("extracts RDS DB name (colon-separated type)", () => {
    expect(extractIdentifierFromArn("arn:aws:rds:us-east-1:123:db:my-db")).toBe(
      "my-db",
    );
  });

  it("extracts CloudWatch alarm name (colon-separated type)", () => {
    expect(
      extractIdentifierFromArn(
        "arn:aws:cloudwatch:us-east-1:123:alarm:my-alarm",
      ),
    ).toBe("my-alarm");
  });

  it("extracts SQS queue name (no separator)", () => {
    expect(extractIdentifierFromArn("arn:aws:sqs:us-east-1:123:my-queue")).toBe(
      "my-queue",
    );
  });

  it("extracts SNS topic name (no separator)", () => {
    expect(extractIdentifierFromArn("arn:aws:sns:us-east-1:123:my-topic")).toBe(
      "my-topic",
    );
  });

  it("preserves SSM canonical leading slash for hierarchical params", () => {
    // CCAPI and SSM require the leading "/" — the CLI already asserts
    // this in its resolver suite. Core helper must match.
    expect(
      extractIdentifierFromArn(
        "arn:aws:ssm:us-east-1:123:parameter/app/config/db-url",
      ),
    ).toBe("/app/config/db-url");
  });

  it("preserves SSM canonical leading slash for simple params", () => {
    expect(
      extractIdentifierFromArn(
        "arn:aws:ssm:us-east-1:123:parameter/smoke-test-x",
      ),
    ).toBe("/smoke-test-x");
  });

  it("extracts log-group path preserving leading slash", () => {
    expect(
      extractIdentifierFromArn(
        "arn:aws:logs:us-east-1:123:log-group:/aws/lambda/my-fn",
      ),
    ).toBe("/aws/lambda/my-fn");
  });

  it("extracts secret name with versioning suffix", () => {
    expect(
      extractIdentifierFromArn(
        "arn:aws:secretsmanager:us-east-1:123:secret:app/db-AbCdEf",
      ),
    ).toBe("app/db-AbCdEf");
  });

  it("extracts api gateway id from /apis/ path", () => {
    expect(
      extractIdentifierFromArn("arn:aws:apigateway:us-east-1::/apis/abc123"),
    ).toBe("abc123");
  });

  it("extracts IAM role name", () => {
    expect(extractIdentifierFromArn("arn:aws:iam::123:role/my-role")).toBe(
      "my-role",
    );
  });

  it("returns input verbatim for malformed ARNs", () => {
    expect(extractIdentifierFromArn("not-an-arn")).toBe("not-an-arn");
  });
});

describe("extractRegionFromArn", () => {
  it("extracts region from regional ARN", () => {
    expect(
      extractRegionFromArn(
        "arn:aws:lambda:eu-west-1:123:function:f",
        "us-east-1",
      ),
    ).toBe("eu-west-1");
  });

  it("returns default for global-service ARN (S3)", () => {
    expect(extractRegionFromArn("arn:aws:s3:::my-bucket", "us-east-1")).toBe(
      "us-east-1",
    );
  });

  it("returns default for IAM ARN (empty region segment)", () => {
    expect(extractRegionFromArn("arn:aws:iam::123:role/r", "us-west-2")).toBe(
      "us-west-2",
    );
  });

  it("works across all partitions", () => {
    for (const { prefix } of PARTITIONS) {
      expect(
        extractRegionFromArn(
          `arn:${prefix}:lambda:ap-southeast-1:123:function:f`,
          "us-east-1",
        ),
      ).toBe("ap-southeast-1");
    }
  });
});

describe("extractAccountIdFromArn", () => {
  it("extracts 12-digit account id", () => {
    expect(
      extractAccountIdFromArn(
        "arn:aws:lambda:us-east-1:123456789012:function:f",
      ),
    ).toBe("123456789012");
  });

  it("returns undefined for S3 ARN (no account segment)", () => {
    expect(extractAccountIdFromArn("arn:aws:s3:::my-bucket")).toBeUndefined();
  });

  it("returns undefined for non-12-digit account", () => {
    expect(
      extractAccountIdFromArn("arn:aws:lambda:us-east-1:short:function:f"),
    ).toBeUndefined();
  });

  it("works across all partitions", () => {
    for (const { prefix } of PARTITIONS) {
      expect(
        extractAccountIdFromArn(
          `arn:${prefix}:ec2:us-east-1:999888777666:vpc/vpc-x`,
        ),
      ).toBe("999888777666");
    }
  });
});

describe("getCloudControlIdentifier", () => {
  it("returns full ARN for SNS Topic", () => {
    const arn = "arn:aws:sns:us-east-1:123:my-topic";
    expect(getCloudControlIdentifier(arn, RESOURCE_TYPES.SNS_TOPIC)).toBe(arn);
  });

  it("returns full ARN for ELBv2 LoadBalancer", () => {
    const arn =
      "arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/my-alb/abc";
    expect(
      getCloudControlIdentifier(arn, RESOURCE_TYPES.ELBV2_LOAD_BALANCER),
    ).toBe(arn);
  });

  it("returns full ARN for ECS Cluster", () => {
    const arn = "arn:aws:ecs:us-east-1:123:cluster/my-cluster";
    expect(getCloudControlIdentifier(arn, RESOURCE_TYPES.ECS_CLUSTER)).toBe(
      arn,
    );
  });

  it("returns full ARN for Events Rule", () => {
    const arn = "arn:aws:events:us-east-1:123:rule/my-rule";
    expect(getCloudControlIdentifier(arn, RESOURCE_TYPES.EVENTS_RULE)).toBe(
      arn,
    );
  });

  it("returns full ARN for SecretsManager Secret", () => {
    const arn = "arn:aws:secretsmanager:us-east-1:123:secret:my/secret-AbC";
    expect(
      getCloudControlIdentifier(arn, RESOURCE_TYPES.SECRETSMANAGER_SECRET),
    ).toBe(arn);
  });

  it("synthesizes SQS queue URL from ARN", () => {
    expect(
      getCloudControlIdentifier(
        "arn:aws:sqs:us-east-1:123:my-queue",
        RESOURCE_TYPES.SQS_QUEUE,
      ),
    ).toBe("https://sqs.us-east-1.amazonaws.com/123/my-queue");
  });

  it("extracts bare identifier for S3 Bucket", () => {
    expect(
      getCloudControlIdentifier(
        "arn:aws:s3:::my-bucket",
        RESOURCE_TYPES.S3_BUCKET,
      ),
    ).toBe("my-bucket");
  });

  it("extracts bare identifier for Lambda function", () => {
    expect(
      getCloudControlIdentifier(
        "arn:aws:lambda:us-east-1:123:function:my-fn",
        RESOURCE_TYPES.LAMBDA_FUNCTION,
      ),
    ).toBe("my-fn");
  });

  it("preserves SSM leading slash", () => {
    expect(
      getCloudControlIdentifier(
        "arn:aws:ssm:us-east-1:123:parameter/app/db",
        RESOURCE_TYPES.SSM_PARAMETER,
      ),
    ).toBe("/app/db");
  });

  it("falls back to extracted identifier when resourceType is null", () => {
    expect(getCloudControlIdentifier("arn:aws:s3:::my-bucket", null)).toBe(
      "my-bucket",
    );
  });

  it("works across all partitions for ARN-identified types", () => {
    for (const { prefix } of PARTITIONS) {
      const arn = `arn:${prefix}:sns:us-east-1:123:topic`;
      expect(getCloudControlIdentifier(arn, RESOURCE_TYPES.SNS_TOPIC)).toBe(
        arn,
      );
    }
  });

  it("works across all partitions for SQS URL synthesis", () => {
    for (const { prefix } of PARTITIONS) {
      expect(
        getCloudControlIdentifier(
          `arn:${prefix}:sqs:eu-west-1:999:my-q`,
          RESOURCE_TYPES.SQS_QUEUE,
        ),
      ).toBe("https://sqs.eu-west-1.amazonaws.com/999/my-q");
    }
  });
});

describe("ARN_IDENTIFIED_RESOURCE_TYPES", () => {
  it("includes all types that use full ARN as CCAPI identifier", () => {
    expect(ARN_IDENTIFIED_RESOURCE_TYPES.has(RESOURCE_TYPES.SNS_TOPIC)).toBe(
      true,
    );
    expect(
      ARN_IDENTIFIED_RESOURCE_TYPES.has(RESOURCE_TYPES.ELBV2_LOAD_BALANCER),
    ).toBe(true);
    expect(ARN_IDENTIFIED_RESOURCE_TYPES.has(RESOURCE_TYPES.ECS_CLUSTER)).toBe(
      true,
    );
    expect(ARN_IDENTIFIED_RESOURCE_TYPES.has(RESOURCE_TYPES.EVENTS_RULE)).toBe(
      true,
    );
    expect(
      ARN_IDENTIFIED_RESOURCE_TYPES.has(RESOURCE_TYPES.SNS_SUBSCRIPTION),
    ).toBe(true);
    expect(
      ARN_IDENTIFIED_RESOURCE_TYPES.has(RESOURCE_TYPES.SECRETSMANAGER_SECRET),
    ).toBe(true);
  });

  it("does NOT include S3 Bucket (uses bare name)", () => {
    expect(ARN_IDENTIFIED_RESOURCE_TYPES.has(RESOURCE_TYPES.S3_BUCKET)).toBe(
      false,
    );
  });

  it("does NOT include SQS Queue (uses queue URL, not ARN)", () => {
    expect(ARN_IDENTIFIED_RESOURCE_TYPES.has(RESOURCE_TYPES.SQS_QUEUE)).toBe(
      false,
    );
  });
});
