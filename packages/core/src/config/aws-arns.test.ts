/**
 * W-010 (Epic 99 Wave 4 Lane 4b) — unit tests for partition-aware managed
 * policy ARN helpers in `aws-arns.ts`.
 *
 * Covers:
 *   - `awsManagedPolicyArn(partition, path)` — happy path for all five
 *     canonical partitions + throw on unrecognised partition.
 *   - `AwsManagedPolicy` PATH constants — correct suffix values.
 *
 * @see feedback_partition_aware_arn_matching (operator memory)
 */

import { describe, it, expect } from "vitest";
import { awsManagedPolicyArn, AwsManagedPolicy } from "./aws-arns.js";

describe("awsManagedPolicyArn", () => {
  describe("commercial partition (aws)", () => {
    it("builds LAMBDA_BASIC_EXECUTION ARN correctly", () => {
      expect(
        awsManagedPolicyArn(
          "aws",
          AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH,
        ),
      ).toBe(
        "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      );
    });

    it("builds POWER_USER_ACCESS ARN correctly", () => {
      expect(
        awsManagedPolicyArn("aws", AwsManagedPolicy.POWER_USER_ACCESS_PATH),
      ).toBe("arn:aws:iam::aws:policy/PowerUserAccess");
    });
  });

  describe("GovCloud partition (aws-us-gov)", () => {
    it("builds LAMBDA_BASIC_EXECUTION ARN with aws-us-gov prefix", () => {
      expect(
        awsManagedPolicyArn(
          "aws-us-gov",
          AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH,
        ),
      ).toBe(
        "arn:aws-us-gov:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      );
    });

    it("builds POWER_USER_ACCESS ARN with aws-us-gov prefix", () => {
      expect(
        awsManagedPolicyArn(
          "aws-us-gov",
          AwsManagedPolicy.POWER_USER_ACCESS_PATH,
        ),
      ).toBe("arn:aws-us-gov:iam::aws:policy/PowerUserAccess");
    });
  });

  describe("China partition (aws-cn)", () => {
    it("builds LAMBDA_BASIC_EXECUTION ARN with aws-cn prefix", () => {
      expect(
        awsManagedPolicyArn(
          "aws-cn",
          AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH,
        ),
      ).toBe(
        "arn:aws-cn:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      );
    });

    it("builds POWER_USER_ACCESS ARN with aws-cn prefix", () => {
      expect(
        awsManagedPolicyArn("aws-cn", AwsManagedPolicy.POWER_USER_ACCESS_PATH),
      ).toBe("arn:aws-cn:iam::aws:policy/PowerUserAccess");
    });
  });

  describe("ISO partition (aws-iso)", () => {
    it("builds POWER_USER_ACCESS ARN with aws-iso prefix", () => {
      expect(
        awsManagedPolicyArn("aws-iso", AwsManagedPolicy.POWER_USER_ACCESS_PATH),
      ).toBe("arn:aws-iso:iam::aws:policy/PowerUserAccess");
    });
  });

  describe("ISO-B partition (aws-iso-b)", () => {
    it("builds POWER_USER_ACCESS ARN with aws-iso-b prefix", () => {
      expect(
        awsManagedPolicyArn(
          "aws-iso-b",
          AwsManagedPolicy.POWER_USER_ACCESS_PATH,
        ),
      ).toBe("arn:aws-iso-b:iam::aws:policy/PowerUserAccess");
    });
  });

  describe("partition validation", () => {
    it("throws RangeError for numeric suffix (aws1)", () => {
      expect(() => awsManagedPolicyArn("aws1", "PowerUserAccess")).toThrow(
        RangeError,
      );
    });

    it("throws RangeError for underscore partition (aws_us_gov)", () => {
      expect(() =>
        awsManagedPolicyArn("aws_us_gov", "PowerUserAccess"),
      ).toThrow(RangeError);
    });

    it("throws RangeError for completely wrong string (azure)", () => {
      expect(() => awsManagedPolicyArn("azure", "PowerUserAccess")).toThrow(
        RangeError,
      );
    });

    it("throws RangeError for empty string", () => {
      expect(() => awsManagedPolicyArn("", "PowerUserAccess")).toThrow(
        RangeError,
      );
    });

    it("error message includes the bad partition for debuggability", () => {
      expect(() => awsManagedPolicyArn("aws_bad", "PowerUserAccess")).toThrow(
        /aws_bad/,
      );
    });
  });

  describe("ARN shape invariants", () => {
    it("produced ARN starts with arn:<partition>:iam::aws:policy/", () => {
      for (const partition of [
        "aws",
        "aws-us-gov",
        "aws-cn",
        "aws-iso",
        "aws-iso-b",
      ] as const) {
        const arn = awsManagedPolicyArn(
          partition,
          AwsManagedPolicy.POWER_USER_ACCESS_PATH,
        );
        expect(arn).toMatch(
          new RegExp(
            `^arn:${partition.replace(/-/g, "\\-")}:iam::aws:policy\\/`,
          ),
        );
      }
    });
  });
});

describe("AwsManagedPolicy constants", () => {
  describe("PATH constants", () => {
    it("LAMBDA_BASIC_EXECUTION_PATH is the correct path suffix", () => {
      expect(AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH).toBe(
        "service-role/AWSLambdaBasicExecutionRole",
      );
    });

    it("POWER_USER_ACCESS_PATH is the correct path suffix", () => {
      expect(AwsManagedPolicy.POWER_USER_ACCESS_PATH).toBe("PowerUserAccess");
    });

    it("PATH constants do NOT start with arn:", () => {
      expect(
        AwsManagedPolicy.LAMBDA_BASIC_EXECUTION_PATH.startsWith("arn:"),
      ).toBe(false);
      expect(AwsManagedPolicy.POWER_USER_ACCESS_PATH.startsWith("arn:")).toBe(
        false,
      );
    });
  });
});
