import { describe, it, expect } from "vitest";
import {
  getPartitionFromRegion,
  ARN_PATTERN,
  ARN_PATTERN_SOURCE,
  isArnOfService,
  type AwsPartition,
} from "./aws-partition.js";

describe("getPartitionFromRegion", () => {
  describe("commercial (aws)", () => {
    const commercial = [
      "us-east-1",
      "us-east-2",
      "us-west-1",
      "us-west-2",
      "eu-west-1",
      "eu-central-1",
      "ap-southeast-1",
      "ap-northeast-1",
      "sa-east-1",
      "ca-central-1",
      "af-south-1",
      "me-south-1",
    ];
    for (const region of commercial) {
      it(`${region} → aws`, () => {
        expect(getPartitionFromRegion(region)).toBe("aws");
      });
    }
  });

  describe("GovCloud (aws-us-gov)", () => {
    it("us-gov-west-1 → aws-us-gov", () => {
      expect(getPartitionFromRegion("us-gov-west-1")).toBe("aws-us-gov");
    });
    it("us-gov-east-1 → aws-us-gov", () => {
      expect(getPartitionFromRegion("us-gov-east-1")).toBe("aws-us-gov");
    });
  });

  describe("China (aws-cn)", () => {
    it("cn-north-1 → aws-cn", () => {
      expect(getPartitionFromRegion("cn-north-1")).toBe("aws-cn");
    });
    it("cn-northwest-1 → aws-cn", () => {
      expect(getPartitionFromRegion("cn-northwest-1")).toBe("aws-cn");
    });
  });

  describe("ISO (aws-iso)", () => {
    it("us-iso-east-1 → aws-iso", () => {
      expect(getPartitionFromRegion("us-iso-east-1")).toBe("aws-iso");
    });
    it("us-iso-west-1 → aws-iso", () => {
      expect(getPartitionFromRegion("us-iso-west-1")).toBe("aws-iso");
    });
  });

  describe("ISOB (aws-iso-b)", () => {
    it("us-isob-east-1 → aws-iso-b", () => {
      expect(getPartitionFromRegion("us-isob-east-1")).toBe("aws-iso-b");
    });
    // Verify precedence — "us-isob-" must NOT match the generic ISO branch
    it("us-isob-east-1 does not accidentally match aws-iso", () => {
      const p = getPartitionFromRegion("us-isob-east-1");
      expect(p).not.toBe("aws-iso");
    });
  });

  describe("return type is narrowed", () => {
    it("is one of the AwsPartition union members", () => {
      const p: AwsPartition = getPartitionFromRegion("us-east-1");
      // compile-time check via assignability; runtime sanity:
      expect([
        "aws",
        "aws-cn",
        "aws-us-gov",
        "aws-iso",
        "aws-iso-b",
        "aws-iso-e",
        "aws-iso-f",
      ]).toContain(p);
    });
  });
});

describe("ARN_PATTERN", () => {
  it.each([
    ["arn:aws:iam::123456789012:role/foo", true],
    ["arn:aws-us-gov:iam::123456789012:role/foo", true],
    ["arn:aws-cn:iam::123456789012:role/foo", true],
    ["arn:aws-iso:iam::123456789012:role/foo", true],
    ["arn:aws-iso-b:iam::123456789012:role/foo", true],
    ["arn:aws-iso-e:iam::123456789012:role/foo", true],
    ["arn:aws-iso-f:iam::123456789012:role/foo", true],
  ])("accepts %s", (input, expected) => {
    expect(ARN_PATTERN.test(input)).toBe(expected);
  });

  it.each([
    ["not-an-arn", false],
    ["", false],
    ["arn:azure:iam::123:role/foo", false],
    ["arn:AWS:iam::123:role/foo", false], // case-sensitive
    ["prefix arn:aws:iam::123:role/foo", false], // anchored
    // Previously the `[\w-]*` pattern would have accepted these malformed
    // partitions — the tightened `(?:-[a-z]+)*` now rejects them.
    ["arn:aws_x:iam::123:role/foo", false], // underscore (not a real partition)
    ["arn:aws1:iam::123:role/foo", false], // digits (not a real partition)
    ["arn:aws-US-GOV:iam::123:role/foo", false], // wrong case in suffix
  ])("rejects %s", (input, expected) => {
    expect(ARN_PATTERN.test(input)).toBe(expected);
  });
});

describe("isArnOfService", () => {
  it.each([
    // commercial + all 5 current + 2 announced partitions, all services
    ["arn:aws:iam::123456789012:role/foo", "iam", true],
    ["arn:aws-us-gov:iam::123456789012:role/foo", "iam", true],
    ["arn:aws-cn:iam::123456789012:role/foo", "iam", true],
    ["arn:aws-iso:iam::123456789012:role/foo", "iam", true],
    ["arn:aws-iso-b:iam::123456789012:role/foo", "iam", true],
    ["arn:aws-iso-e:iam::123456789012:role/foo", "iam", true],
    ["arn:aws-iso-f:iam::123456789012:role/foo", "iam", true],
    // S3 (no region/account segments)
    ["arn:aws:s3:::my-bucket", "s3", true],
    ["arn:aws-cn:s3:::my-bucket", "s3", true],
    // SQS / SNS / KMS / LAMBDA / LOGS / BEDROCK / EC2 across partitions
    ["arn:aws-us-gov:sqs:us-gov-west-1:123456789012:q", "sqs", true],
    ["arn:aws-cn:sns:cn-north-1:123456789012:t", "sns", true],
    ["arn:aws-iso:kms:us-iso-east-1:123456789012:key/k", "kms", true],
    [
      "arn:aws-us-gov:lambda:us-gov-west-1:123456789012:function:f",
      "lambda",
      true,
    ],
    ["arn:aws-cn:logs:cn-north-1:123456789012:log-group:g", "logs", true],
    [
      "arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/x",
      "bedrock",
      true,
    ],
    ["arn:aws-cn:ec2:cn-north-1:123456789012:vpc/vpc-abc", "ec2", true],
  ])("accepts %s for service %s", (input, service, expected) => {
    expect(isArnOfService(input, service)).toBe(expected);
  });

  it.each([
    ["arn:aws:iam::123:role/foo", "sqs", false], // service mismatch
    ["arn:aws:s3:::bucket", "sns", false],
    ["not-an-arn", "iam", false],
    ["", "iam", false],
    ["arn:aws_x:iam::123:role/foo", "iam", false], // malformed partition
    ["arn:azure:iam::123:role/foo", "iam", false],
  ])("rejects %s for service %s", (input, service, expected) => {
    expect(isArnOfService(input, service)).toBe(expected);
  });
});

describe("ARN_PATTERN_SOURCE", () => {
  it("composes into a global scan regex", () => {
    const re = new RegExp(
      `${ARN_PATTERN_SOURCE}[a-z0-9-]+:[a-z0-9-]*:\\d{12}:[^\\s]*`,
      "g",
    );
    const input =
      "error in arn:aws:iam::123456789012:role/A and arn:aws-us-gov:lambda:us-gov-west-1:123456789012:function:foo or arn:aws-cn:sqs:cn-north-1:999999999999:q";
    const matches = input.match(re) ?? [];
    expect(matches).toHaveLength(3);
    expect(matches[0]).toContain("arn:aws:");
    expect(matches[1]).toContain("arn:aws-us-gov:");
    expect(matches[2]).toContain("arn:aws-cn:");
  });

  it("does not contain the anchor", () => {
    expect(ARN_PATTERN_SOURCE.startsWith("^")).toBe(false);
  });
});
