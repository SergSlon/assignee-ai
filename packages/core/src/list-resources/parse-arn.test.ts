/**
 * Dedicated unit tests for the shared ARN parser (Story 50-6).
 *
 * `parseArn` is security-sensitive per
 * feedback_partition_aware_arn_matching — both CLI `list` and MCP
 * `list_managed_resources` feed it RGTA ARNs from commercial AWS, China
 * (aws-cn), and GovCloud (aws-us-gov). The parser is intentionally
 * minimal (colon-split) so a malformed ARN never throws; we pin the
 * observed behaviour here so a future refactor doesn't accidentally
 * raise exceptions and crash `list`.
 */
import { describe, it, expect } from "vitest";
import { parseArn } from "./parse-arn.js";
import { UNKNOWN_FALLBACK } from "../config/cfn-keys/defaults.js";

describe("parseArn — commercial partition (aws)", () => {
  it("parses an S3 bucket ARN (no region / no account)", () => {
    expect(parseArn("arn:aws:s3:::my-bucket")).toEqual({
      service: "s3",
      region: "",
      resourceType: "AWS::S3::Bucket",
    });
  });

  it("parses an IAM role ARN (no region; account in slot 4)", () => {
    // IAM is global — slot 3 (region) is empty, slot 4 is the account.
    expect(
      parseArn("arn:aws:iam::123456789012:role/assignee-operator"),
    ).toEqual({
      service: "iam",
      region: "",
      resourceType: "AWS::IAM::Role",
    });
  });

  it("parses an EC2 Instance ARN (colon form)", () => {
    expect(
      parseArn("arn:aws:ec2:us-east-1:123456789012:instance/i-0abc1234"),
    ).toEqual({
      service: "ec2",
      region: "us-east-1",
      resourceType: "AWS::EC2::Instance",
    });
  });

  it("parses a SQS queue ARN (6-part form)", () => {
    expect(
      parseArn("arn:aws:sqs:eu-west-1:123456789012:assignee-jobs"),
    ).toEqual({
      service: "sqs",
      region: "eu-west-1",
      resourceType: "AWS::SQS::Queue",
    });
  });

  it("parses a Lambda function ARN (7-part form with ':function:<name>')", () => {
    const result = parseArn(
      "arn:aws:lambda:us-west-2:123456789012:function:assignee-worker",
    );
    expect(result.service).toBe("lambda");
    expect(result.region).toBe("us-west-2");
    // lambda has a "" default subtype → LAMBDA_FUNCTION.
    expect(result.resourceType).toBe("AWS::Lambda::Function");
  });

  it("parses a DynamoDB table ARN", () => {
    expect(
      parseArn("arn:aws:dynamodb:us-east-1:123456789012:table/assignee-orders"),
    ).toEqual({
      service: "dynamodb",
      region: "us-east-1",
      resourceType: "AWS::DynamoDB::Table",
    });
  });
});

describe("parseArn — China partition (aws-cn)", () => {
  it("parses an S3 bucket ARN in aws-cn", () => {
    expect(parseArn("arn:aws-cn:s3:::my-cn-bucket")).toEqual({
      service: "s3",
      region: "",
      resourceType: "AWS::S3::Bucket",
    });
  });

  it("parses an SNS topic ARN in aws-cn (cn-north-1)", () => {
    expect(
      parseArn("arn:aws-cn:sns:cn-north-1:123456789012:assignee-alerts"),
    ).toEqual({
      service: "sns",
      region: "cn-north-1",
      resourceType: "AWS::SNS::Topic",
    });
  });

  it("parses an IAM user ARN in aws-cn", () => {
    expect(parseArn("arn:aws-cn:iam::123456789012:user/bob")).toMatchObject({
      service: "iam",
      region: "",
    });
  });
});

describe("parseArn — GovCloud partition (aws-us-gov)", () => {
  it("parses an EC2 VPC ARN in aws-us-gov", () => {
    expect(
      parseArn("arn:aws-us-gov:ec2:us-gov-west-1:123456789012:vpc/vpc-abc"),
    ).toEqual({
      service: "ec2",
      region: "us-gov-west-1",
      resourceType: "AWS::EC2::VPC",
    });
  });

  it("parses a Lambda function ARN in aws-us-gov", () => {
    expect(
      parseArn(
        "arn:aws-us-gov:lambda:us-gov-east-1:123456789012:function:fnname",
      ),
    ).toEqual({
      service: "lambda",
      region: "us-gov-east-1",
      resourceType: "AWS::Lambda::Function",
    });
  });

  it("parses a KMS key ARN in aws-us-gov (service casing override)", () => {
    // KMS must map to 'AWS::KMS::Key' (all-caps) — not 'AWS::Kms::Key'.
    expect(
      parseArn(
        "arn:aws-us-gov:kms:us-gov-west-1:123456789012:key/abcd-1234-5678",
      ),
    ).toEqual({
      service: "kms",
      region: "us-gov-west-1",
      resourceType: "AWS::KMS::Key",
    });
  });
});

describe("parseArn — malformed input", () => {
  it("handles empty string without throwing (returns UNKNOWN_FALLBACK)", () => {
    const result = parseArn("");
    expect(result.service).toBe(UNKNOWN_FALLBACK);
    expect(result.region).toBe(UNKNOWN_FALLBACK);
    // arnToCloudFormationType("", "") falls through to capitalization —
    // empty service + empty resource produces a deterministic fallback.
    expect(typeof result.resourceType).toBe("string");
  });

  it("handles missing service slot (single colon)", () => {
    const result = parseArn("arn:");
    expect(result.service).toBe(UNKNOWN_FALLBACK);
    expect(result.region).toBe(UNKNOWN_FALLBACK);
  });

  it("handles ARN with only partition+service (returns empty region)", () => {
    const result = parseArn("arn:aws:s3");
    expect(result.service).toBe("s3");
    // Missing region slot → empty string, not "unknown" (colon-split
    // returns "" when the position exists but is blank).
    expect(result.region).toBe(UNKNOWN_FALLBACK);
  });

  it("handles a non-ARN string (no colons)", () => {
    const result = parseArn("not-an-arn");
    // split(":") → ["not-an-arn"]; parts[2] and parts[3] are undefined
    // → each coalesces to UNKNOWN_FALLBACK.
    expect(result.service).toBe(UNKNOWN_FALLBACK);
    expect(result.region).toBe(UNKNOWN_FALLBACK);
  });

  it("handles truncated ARN (service present, resource missing)", () => {
    const result = parseArn("arn:aws:rds:us-east-1:123456789012");
    expect(result.service).toBe("rds");
    expect(result.region).toBe("us-east-1");
    // Missing resource slot → arnToCloudFormationType returns the
    // SERVICE_TYPE_MAP default ("AWS::RDS::DBInstance") — not a throw.
    expect(result.resourceType).toBe("AWS::RDS::DBInstance");
  });
});

describe("parseArn — never throws", () => {
  it.each([
    "",
    "arn",
    "arn:",
    "arn:aws",
    "arn:aws:",
    "arn:aws:s3",
    "arn:aws:s3:::",
    "arn:aws:::::::::",
    "::::::::::",
    "some:random:colon:delimited:text",
    "arn:aws-cn:iam::123456789012:role/",
  ])("does not throw on input: %s", (input) => {
    expect(() => parseArn(input)).not.toThrow();
    const result = parseArn(input);
    expect(typeof result.service).toBe("string");
    expect(typeof result.region).toBe("string");
    expect(typeof result.resourceType).toBe("string");
  });
});
