/**
 * Tests for ccapi-partition-support matrix (W5-04, P055 → L5-S08).
 * Verifies isCcapiSupported() + assertCcapiSupportedOrActionableError() behaviour
 * across all partitions.
 */
import { describe, it, expect } from "vitest";
import {
  isCcapiSupported,
  assertCcapiSupportedOrActionableError,
  hasSdkDirectFallback,
  SDK_DIRECT_FALLBACK_TYPES,
} from "./ccapi-partition-support.js";

describe("isCcapiSupported", () => {
  describe("commercial (aws) — all types assumed supported", () => {
    it("supports S3::Bucket in aws", () => {
      expect(isCcapiSupported("aws", "AWS::S3::Bucket")).toBe(true);
    });
    it("supports IAM::Role in aws", () => {
      expect(isCcapiSupported("aws", "AWS::IAM::Role")).toBe(true);
    });
    it("supports arbitrary type in aws (commercial = no restriction)", () => {
      expect(isCcapiSupported("aws", "AWS::SomeUnknown::Type")).toBe(true);
    });
  });

  describe("GovCloud (aws-us-gov)", () => {
    // S3 / IAM / VPC are routed through W5-04 SDK-direct adapters in
    // non-commercial partitions; isCcapiSupported() returns false for them
    // so the partition-aware router prefers the SDK-direct path.
    it("S3::Bucket is NOT marked CCAPI-supported (routes via SDK-direct)", () => {
      expect(isCcapiSupported("aws-us-gov", "AWS::S3::Bucket")).toBe(false);
    });
    it("IAM::Role is NOT marked CCAPI-supported (routes via SDK-direct)", () => {
      expect(isCcapiSupported("aws-us-gov", "AWS::IAM::Role")).toBe(false);
    });
    it("EC2::Subnet is supported (CCAPI-only; no SDK-direct fallback)", () => {
      expect(isCcapiSupported("aws-us-gov", "AWS::EC2::Subnet")).toBe(true);
    });
    it("Lambda::Function is supported (CCAPI-only; no SDK-direct fallback)", () => {
      expect(isCcapiSupported("aws-us-gov", "AWS::Lambda::Function")).toBe(
        true,
      );
    });
    it("CloudFront::Distribution is not supported", () => {
      expect(
        isCcapiSupported("aws-us-gov", "AWS::CloudFront::Distribution"),
      ).toBe(false);
    });
    it("unknown type is not supported", () => {
      expect(isCcapiSupported("aws-us-gov", "AWS::SomeNew::Service")).toBe(
        false,
      );
    });
  });

  describe("China (aws-cn)", () => {
    it("S3::Bucket is NOT marked CCAPI-supported (routes via SDK-direct)", () => {
      expect(isCcapiSupported("aws-cn", "AWS::S3::Bucket")).toBe(false);
    });
    it("EC2::VPC is NOT marked CCAPI-supported (routes via SDK-direct)", () => {
      expect(isCcapiSupported("aws-cn", "AWS::EC2::VPC")).toBe(false);
    });
    it("DynamoDB::Table is supported (CCAPI-only; no SDK-direct fallback)", () => {
      expect(isCcapiSupported("aws-cn", "AWS::DynamoDB::Table")).toBe(true);
    });
    it("Lambda::Function is not supported", () => {
      expect(isCcapiSupported("aws-cn", "AWS::Lambda::Function")).toBe(false);
    });
  });

  describe("ISO (aws-iso)", () => {
    it("S3::Bucket is NOT marked CCAPI-supported (routes via SDK-direct)", () => {
      expect(isCcapiSupported("aws-iso", "AWS::S3::Bucket")).toBe(false);
    });
    it("IAM::Role is NOT marked CCAPI-supported (routes via SDK-direct)", () => {
      expect(isCcapiSupported("aws-iso", "AWS::IAM::Role")).toBe(false);
    });
    it("EC2::Subnet is supported (CCAPI-only; no SDK-direct fallback)", () => {
      expect(isCcapiSupported("aws-iso", "AWS::EC2::Subnet")).toBe(true);
    });
    it("DynamoDB::Table is not supported", () => {
      expect(isCcapiSupported("aws-iso", "AWS::DynamoDB::Table")).toBe(false);
    });
  });

  describe("EU Sovereign Cloud (aws-iso-e) — W5-02", () => {
    it("S3::Bucket is NOT marked CCAPI-supported (routes via SDK-direct)", () => {
      expect(isCcapiSupported("aws-iso-e", "AWS::S3::Bucket")).toBe(false);
    });
    it("EC2::VPC is NOT marked CCAPI-supported (routes via SDK-direct)", () => {
      expect(isCcapiSupported("aws-iso-e", "AWS::EC2::VPC")).toBe(false);
    });
    it("EC2::Subnet is supported (CCAPI-only; no SDK-direct fallback)", () => {
      expect(isCcapiSupported("aws-iso-e", "AWS::EC2::Subnet")).toBe(true);
    });
    it("Lambda::Function is not supported in eu-isoe", () => {
      expect(isCcapiSupported("aws-iso-e", "AWS::Lambda::Function")).toBe(
        false,
      );
    });
    it("SecretsManager::Secret is not supported in eu-isoe", () => {
      expect(isCcapiSupported("aws-iso-e", "AWS::SecretsManager::Secret")).toBe(
        false,
      );
    });
  });

  describe("unknown partition", () => {
    it("returns false for completely unknown partition", () => {
      expect(isCcapiSupported("aws-mystery", "AWS::S3::Bucket")).toBe(false);
    });
  });
});

describe("assertCcapiSupportedOrActionableError", () => {
  it("does not throw for supported type in aws", () => {
    expect(() =>
      assertCcapiSupportedOrActionableError("aws", "AWS::S3::Bucket"),
    ).not.toThrow();
  });

  it("does not throw for CCAPI-supported type in aws-us-gov", () => {
    // EC2::Subnet is CCAPI-supported in GovCloud (no SDK-direct fallback).
    expect(() =>
      assertCcapiSupportedOrActionableError("aws-us-gov", "AWS::EC2::Subnet"),
    ).not.toThrow();
  });

  it("throws an actionable error for unsupported type in aws-cn", () => {
    expect(() =>
      assertCcapiSupportedOrActionableError("aws-cn", "AWS::Lambda::Function"),
    ).toThrow(/aws-cn/);
  });

  it("error message names the resource type", () => {
    expect(() =>
      assertCcapiSupportedOrActionableError(
        "aws-iso-e",
        "AWS::SecretsManager::Secret",
      ),
    ).toThrow(/AWS::SecretsManager::Secret/);
  });

  it("error message includes docs URL", () => {
    let thrown = "";
    try {
      assertCcapiSupportedOrActionableError("aws-iso", "AWS::ECS::Cluster");
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e);
    }
    expect(thrown).toContain("docs.aws.amazon.com/cloudcontrolapi");
  });
});

describe("hasSdkDirectFallback", () => {
  it("returns true for AWS::S3::Bucket", () => {
    expect(hasSdkDirectFallback("AWS::S3::Bucket")).toBe(true);
  });
  it("returns true for AWS::IAM::Role", () => {
    expect(hasSdkDirectFallback("AWS::IAM::Role")).toBe(true);
  });
  it("returns true for AWS::EC2::VPC", () => {
    expect(hasSdkDirectFallback("AWS::EC2::VPC")).toBe(true);
  });
  it("returns false for unimplemented types", () => {
    expect(hasSdkDirectFallback("AWS::Lambda::Function")).toBe(false);
    expect(hasSdkDirectFallback("AWS::DynamoDB::Table")).toBe(false);
  });

  it("SDK_DIRECT_FALLBACK_TYPES contains exactly 3 entries (W5-04 scope)", () => {
    expect(SDK_DIRECT_FALLBACK_TYPES.size).toBe(3);
  });
});
