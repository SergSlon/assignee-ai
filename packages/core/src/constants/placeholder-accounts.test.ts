import { describe, it, expect } from "vitest";
import {
  ARN_ACCOUNT_REGEX,
  PLACEHOLDER_AWS_ACCOUNT_IDS,
} from "./placeholder-accounts.js";

/**
 * Locks in L5-003 (Story 56-it2-02): `ARN_ACCOUNT_REGEX` must accept every
 * published AWS partition AND reject malformed partitions. The previous
 * `[\w-]*` pattern silently accepted underscores, digits, and uppercase
 * which is not a real AWS ARN shape.
 */
describe("ARN_ACCOUNT_REGEX (canonical partition matcher)", () => {
  describe("accepts canonical partitions", () => {
    it("extracts account id from commercial (arn:aws:) ARNs", () => {
      const match = ARN_ACCOUNT_REGEX.exec(
        "arn:aws:iam::123456789012:role/ExampleRole",
      );
      expect(match?.[1]).toBe("123456789012");
    });

    it("extracts account id from GovCloud (arn:aws-us-gov:) ARNs", () => {
      const match = ARN_ACCOUNT_REGEX.exec(
        "arn:aws-us-gov:s3:::111122223333-bucket",
      );
      // Note: S3 ARNs don't have an account segment at position 4 — this
      // regex only matches ARN shapes where segment 4 IS the 12-digit
      // account. Use IAM / Lambda / most services as the valid case.
      expect(match).toBeNull();

      const iamMatch = ARN_ACCOUNT_REGEX.exec(
        "arn:aws-us-gov:iam::333333333333:role/GovRole",
      );
      expect(iamMatch?.[1]).toBe("333333333333");
    });

    it("extracts account id from China (arn:aws-cn:) ARNs", () => {
      const match = ARN_ACCOUNT_REGEX.exec(
        "arn:aws-cn:lambda:cn-north-1:222222222222:function:my-fn",
      );
      expect(match?.[1]).toBe("222222222222");
    });

    it("extracts account id from ISO (arn:aws-iso:) ARNs", () => {
      const match = ARN_ACCOUNT_REGEX.exec(
        "arn:aws-iso:iam::444455556666:user/IsoUser",
      );
      expect(match?.[1]).toBe("444455556666");
    });

    it("extracts account id from ISOB (arn:aws-iso-b:) ARNs", () => {
      const match = ARN_ACCOUNT_REGEX.exec(
        "arn:aws-iso-b:iam::555555555555:role/IsoBRole",
      );
      expect(match?.[1]).toBe("555555555555");
    });
  });

  describe("rejects malformed partitions", () => {
    it("rejects uppercase partition (arn:AWS_BAD_PARTITION:...)", () => {
      const match = ARN_ACCOUNT_REGEX.exec(
        "arn:AWS_BAD_PARTITION:iam::123456789012:role/Evil",
      );
      expect(match).toBeNull();
    });

    it("rejects underscore in partition (arn:aws_x:...)", () => {
      const match = ARN_ACCOUNT_REGEX.exec(
        "arn:aws_x:iam::123456789012:role/Evil",
      );
      expect(match).toBeNull();
    });

    it("rejects digit in partition (arn:aws1:...)", () => {
      const match = ARN_ACCOUNT_REGEX.exec(
        "arn:aws1:iam::123456789012:role/Evil",
      );
      expect(match).toBeNull();
    });

    it("rejects non-ARN strings", () => {
      expect(ARN_ACCOUNT_REGEX.exec("not-an-arn")).toBeNull();
      expect(ARN_ACCOUNT_REGEX.exec("")).toBeNull();
      expect(ARN_ACCOUNT_REGEX.exec("123456789012")).toBeNull();
    });

    it("rejects ARN missing the 12-digit account segment", () => {
      // Only 11 digits.
      expect(
        ARN_ACCOUNT_REGEX.exec("arn:aws:iam::12345678901:role/X"),
      ).toBeNull();
      // 13 digits — still rejected because the capture requires exactly 12.
      expect(
        ARN_ACCOUNT_REGEX.exec("arn:aws:iam::1234567890123:role/X"),
      ).toBeNull();
    });
  });
});

describe("PLACEHOLDER_AWS_ACCOUNT_IDS", () => {
  it("contains the canonical AWS docs example account", () => {
    expect(PLACEHOLDER_AWS_ACCOUNT_IDS.has("123456789012")).toBe(true);
  });

  it("rejects real-looking account IDs not in the placeholder set", () => {
    expect(PLACEHOLDER_AWS_ACCOUNT_IDS.has("616138583010")).toBe(false);
  });
});
