import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "@assignee/core";
import { costAlternatives } from "./cost-advisor.js";

describe("costAlternatives", () => {
  describe("EC2", () => {
    it("suggests ARM alternative for t3 instances", () => {
      const hints = costAlternatives(RESOURCE_TYPES.EC2_INSTANCE, {
        InstanceType: "t3.micro",
      });
      expect(hints.some((h) => h.includes("t4g.micro"))).toBe(true);
    });

    it("suggests ARM alternative for m5 instances", () => {
      const hints = costAlternatives(RESOURCE_TYPES.EC2_INSTANCE, {
        InstanceType: "m5.large",
      });
      expect(hints.some((h) => h.includes("m6g.large"))).toBe(true);
    });

    it("suggests ARM alternative for c5 instances", () => {
      const hints = costAlternatives(RESOURCE_TYPES.EC2_INSTANCE, {
        InstanceType: "c5.xlarge",
      });
      expect(hints.some((h) => h.includes("c6g.xlarge"))).toBe(true);
    });

    it("suggests spot for burstable instances", () => {
      const hints = costAlternatives(RESOURCE_TYPES.EC2_INSTANCE, {
        InstanceType: "t3.micro",
      });
      expect(hints.some((h) => h.includes("Spot Instances"))).toBe(true);
    });

    it("returns empty for missing InstanceType", () => {
      const hints = costAlternatives(RESOURCE_TYPES.EC2_INSTANCE, {
        ImageId: "ami-abc123",
      });
      expect(hints).toHaveLength(0);
    });
  });

  describe("RDS", () => {
    it("suggests smaller class for r5/r6g instances", () => {
      const hints = costAlternatives(RESOURCE_TYPES.RDS_DB_INSTANCE, {
        DBInstanceClass: "db.r5.large",
        Engine: "postgres",
      });
      expect(hints.some((h) => h.includes("db.t3.medium"))).toBe(true);
    });

    it("notes Multi-AZ cost doubling", () => {
      const hints = costAlternatives(RESOURCE_TYPES.RDS_DB_INSTANCE, {
        DBInstanceClass: "db.t3.micro",
        MultiAZ: true,
      });
      expect(hints.some((h) => h.includes("doubles the instance cost"))).toBe(
        true,
      );
    });
  });

  describe("S3", () => {
    it("suggests lifecycle rules when missing", () => {
      const hints = costAlternatives(RESOURCE_TYPES.S3_BUCKET, {
        BucketName: "my-logs",
      });
      expect(hints.some((h) => h.includes("lifecycle rules"))).toBe(true);
    });

    it("does not suggest lifecycle when already configured", () => {
      const hints = costAlternatives(RESOURCE_TYPES.S3_BUCKET, {
        BucketName: "my-logs",
        LifecycleConfiguration: { Rules: [] },
      });
      expect(hints.some((h) => h.includes("lifecycle"))).toBe(false);
    });
  });

  describe("Lambda", () => {
    it("suggests lower memory when > 512MB", () => {
      const hints = costAlternatives(RESOURCE_TYPES.LAMBDA_FUNCTION, {
        FunctionName: "my-fn",
        MemorySize: 1024,
      });
      expect(hints.some((h) => h.includes("1024MB"))).toBe(true);
    });

    it("does not suggest lower memory when <= 512MB", () => {
      const hints = costAlternatives(RESOURCE_TYPES.LAMBDA_FUNCTION, {
        FunctionName: "my-fn",
        MemorySize: 256,
      });
      expect(hints).toHaveLength(0);
    });
  });

  describe("free resources", () => {
    it("returns empty for IAM Role", () => {
      const hints = costAlternatives(RESOURCE_TYPES.IAM_ROLE, {
        RoleName: "my-role",
      });
      expect(hints).toHaveLength(0);
    });
  });
});
