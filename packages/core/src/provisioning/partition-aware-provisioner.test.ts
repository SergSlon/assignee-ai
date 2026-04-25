/**
 * Tests for partition-aware provisioning router (W5-04, P055 → L5-S08).
 * Verifies that commercial-partition requests pass through (handled: false),
 * SDK-direct fallback runs for supported types in non-commercial partitions,
 * and actionable errors are thrown for unsupported types.
 */
import { describe, it, expect, vi } from "vitest";
import { routeProvisioningByPartition } from "./partition-aware-provisioner.js";

// Mock the SDK-direct adapters — we test the routing logic, not the adapters.
// Plain async functions (not vi.fn) avoid the vi.fn-mockResolvedValue lifecycle
// where the chained value can be reset by parallel test-file mock-clear ops.
vi.mock("./sdk-direct-fallback/s3-bucket.js", () => ({
  createS3BucketSdkDirect: async (
    _desiredStateJson: string,
    _region: string,
  ) => ({
    requestToken: "SDK_DIRECT_COMPLETE",
    identifier: "my-test-bucket",
  }),
}));

vi.mock("./sdk-direct-fallback/iam-role.js", () => ({
  createIamRoleSdkDirect: async (
    _desiredStateJson: string,
    _region: string,
  ) => ({
    requestToken: "SDK_DIRECT_COMPLETE",
    identifier: "my-test-role",
  }),
}));

vi.mock("./sdk-direct-fallback/ec2-vpc.js", () => ({
  createEc2VpcSdkDirect: async (
    _desiredStateJson: string,
    _region: string,
  ) => ({
    requestToken: "SDK_DIRECT_COMPLETE",
    identifier: "vpc-0a1b2c3d",
  }),
}));

const S3_DESIRED = JSON.stringify({ BucketName: "my-test-bucket" });
const IAM_DESIRED = JSON.stringify({
  RoleName: "my-test-role",
  AssumeRolePolicyDocument: JSON.stringify({
    Version: "2012-10-17",
    Statement: [],
  }),
});
const VPC_DESIRED = JSON.stringify({ CidrBlock: "10.0.0.0/16" });

describe("routeProvisioningByPartition", () => {
  describe("commercial partition (aws) — no routing, handled: false", () => {
    it("returns handled: false for S3::Bucket in us-east-1", async () => {
      const result = await routeProvisioningByPartition(
        "AWS::S3::Bucket",
        S3_DESIRED,
        "us-east-1",
      );
      expect(result.handled).toBe(false);
    });

    it("returns handled: false for Lambda::Function in us-west-2", async () => {
      const result = await routeProvisioningByPartition(
        "AWS::Lambda::Function",
        JSON.stringify({ FunctionName: "fn" }),
        "us-west-2",
      );
      expect(result.handled).toBe(false);
    });

    it("returns handled: false for arbitrary type in eu-central-1 (commercial)", async () => {
      const result = await routeProvisioningByPartition(
        "AWS::SomeNew::Service",
        "{}",
        "eu-central-1",
      );
      expect(result.handled).toBe(false);
    });
  });

  describe("GovCloud partition — SDK-direct fallback for supported types", () => {
    it("routes S3::Bucket to SDK-direct fallback in us-gov-east-1", async () => {
      const result = await routeProvisioningByPartition(
        "AWS::S3::Bucket",
        S3_DESIRED,
        "us-gov-east-1",
      );
      expect(result.handled).toBe(true);
      expect(result.identifier).toBe("my-test-bucket");
    });

    it("routes IAM::Role to SDK-direct fallback in us-gov-west-1", async () => {
      const result = await routeProvisioningByPartition(
        "AWS::IAM::Role",
        IAM_DESIRED,
        "us-gov-west-1",
      );
      expect(result.handled).toBe(true);
      expect(result.identifier).toBe("my-test-role");
    });

    it("routes EC2::VPC to SDK-direct fallback in us-gov-east-1", async () => {
      const result = await routeProvisioningByPartition(
        "AWS::EC2::VPC",
        VPC_DESIRED,
        "us-gov-east-1",
      );
      expect(result.handled).toBe(true);
      expect(result.identifier).toBe("vpc-0a1b2c3d");
    });
  });

  describe("EU Sovereign Cloud (aws-iso-e) — W5-02 region eu-isoe-west-1", () => {
    it("routes S3::Bucket to SDK-direct in eu-isoe-west-1", async () => {
      const result = await routeProvisioningByPartition(
        "AWS::S3::Bucket",
        S3_DESIRED,
        "eu-isoe-west-1",
      );
      expect(result.handled).toBe(true);
    });

    it("throws actionable error for Lambda::Function in eu-isoe-west-1 (unsupported)", async () => {
      await expect(
        routeProvisioningByPartition(
          "AWS::Lambda::Function",
          JSON.stringify({ FunctionName: "fn" }),
          "eu-isoe-west-1",
        ),
      ).rejects.toThrow(/aws-iso-e/);
    });

    it("actionable error names the resource type", async () => {
      await expect(
        routeProvisioningByPartition(
          "AWS::SecretsManager::Secret",
          "{}",
          "eu-isoe-west-1",
        ),
      ).rejects.toThrow(/AWS::SecretsManager::Secret/);
    });
  });

  describe("China partition (aws-cn)", () => {
    it("routes S3::Bucket to SDK-direct in cn-north-1", async () => {
      const result = await routeProvisioningByPartition(
        "AWS::S3::Bucket",
        S3_DESIRED,
        "cn-north-1",
      );
      expect(result.handled).toBe(true);
    });

    it("throws actionable error for CloudFront::Distribution in cn-north-1", async () => {
      await expect(
        routeProvisioningByPartition(
          "AWS::CloudFront::Distribution",
          "{}",
          "cn-north-1",
        ),
      ).rejects.toThrow(/aws-cn/);
    });
  });
});
