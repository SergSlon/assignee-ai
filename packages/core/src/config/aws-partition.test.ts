import { describe, it, expect } from "vitest";
import {
  getPartitionFromRegion,
  ARN_PATTERN,
  ARN_PATTERN_SOURCE,
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
      expect(["aws", "aws-cn", "aws-us-gov", "aws-iso", "aws-iso-b"]).toContain(
        p,
      );
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
  ])("rejects %s", (input, expected) => {
    expect(ARN_PATTERN.test(input)).toBe(expected);
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
