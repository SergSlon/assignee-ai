import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "@assignee/core";
import { validateCoherence } from "./coherence-validator.js";

describe("validateCoherence", () => {
  describe("EC2 SSH contradictions", () => {
    it("warns when SSH key set but no public IP", () => {
      const warnings = validateCoherence(
        { KeyName: "my-key", InstanceType: "t3.micro" },
        "Create an EC2 with SSH",
        RESOURCE_TYPES.EC2_INSTANCE,
      );
      expect(warnings.some((w) => w.id === "ssh-no-public-ip")).toBe(true);
    });

    it("warns when SSH key set but no security group", () => {
      const warnings = validateCoherence(
        { KeyName: "my-key", AssociatePublicIpAddress: true },
        "Create an EC2 with SSH",
        RESOURCE_TYPES.EC2_INSTANCE,
      );
      expect(warnings.some((w) => w.id === "ssh-no-sg")).toBe(true);
    });

    it("warns about both: no public IP AND no security group", () => {
      const warnings = validateCoherence(
        { KeyName: "assignee-ssh-key" },
        "Create an EC2 with SSH",
        RESOURCE_TYPES.EC2_INSTANCE,
      );
      expect(warnings).toHaveLength(2);
      expect(warnings.some((w) => w.id === "ssh-no-public-ip")).toBe(true);
      expect(warnings.some((w) => w.id === "ssh-no-sg")).toBe(true);
    });

    it("no warnings when SSH key + public IP + security group all set", () => {
      const warnings = validateCoherence(
        {
          KeyName: "my-key",
          AssociatePublicIpAddress: true,
          SecurityGroupIds: ["sg-abc123"],
        },
        "Create an EC2 with SSH",
        RESOURCE_TYPES.EC2_INSTANCE,
      );
      expect(warnings).toHaveLength(0);
    });

    it("no warnings when no SSH key is set", () => {
      const warnings = validateCoherence(
        { InstanceType: "t3.micro" },
        "Create an EC2 instance",
        RESOURCE_TYPES.EC2_INSTANCE,
      );
      expect(warnings).toHaveLength(0);
    });

    it("no warnings when KeyName is empty string", () => {
      const warnings = validateCoherence(
        { KeyName: "", InstanceType: "t3.micro" },
        "Create an EC2 instance",
        RESOURCE_TYPES.EC2_INSTANCE,
      );
      expect(warnings).toHaveLength(0);
    });
  });

  describe("S3 public access", () => {
    it("warns when public access enabled without 'public' in intent", () => {
      const warnings = validateCoherence(
        { BucketName: "my-bucket", PublicAccessBlockConfiguration: false },
        "Create an S3 bucket for logs",
        RESOURCE_TYPES.S3_BUCKET,
      );
      expect(warnings.some((w) => w.id === "s3-public-unintended")).toBe(true);
    });

    it("no warning when public access enabled AND intent says 'public'", () => {
      const warnings = validateCoherence(
        { BucketName: "my-bucket", PublicAccessBlockConfiguration: false },
        "Create a public S3 bucket for static website",
        RESOURCE_TYPES.S3_BUCKET,
      );
      expect(warnings).toHaveLength(0);
    });

    it("no warning when public access block is enabled", () => {
      const warnings = validateCoherence(
        { BucketName: "my-bucket", PublicAccessBlockConfiguration: true },
        "Create an S3 bucket",
        RESOURCE_TYPES.S3_BUCKET,
      );
      expect(warnings).toHaveLength(0);
    });
  });

  describe("unsupported resource types", () => {
    it("returns empty for Lambda", () => {
      const warnings = validateCoherence(
        { FunctionName: "my-fn" },
        "Create a Lambda function",
        RESOURCE_TYPES.LAMBDA_FUNCTION,
      );
      expect(warnings).toHaveLength(0);
    });
  });
});
