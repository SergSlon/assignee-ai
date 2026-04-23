/**
 * Unit tests for the skeletal-plan-detector (e98.W5.N5 / C-N3 + C-N4 + C-P3).
 *
 * Locks:
 *   1. C-N3 HIGH RDS: empty `VPCSecurityGroups` array → isSkeletal=true,
 *      advisory with PLAN_SKELETAL code + RDS-specific hint text.
 *   2. C-N3 HIGH RDS: missing `DBSubnetGroupName` string → same.
 *   3. C-N4 LOW ALB: empty `Subnets` OR `SecurityGroups` → isSkeletal;
 *      ALB-specific hint text with `three-tier-web` compound pointer.
 *   4. C-P3 LOW RDS DBSubnetGroup: empty `SubnetIds` → isSkeletal.
 *   5. Non-allowlisted resourceType: isSkeletal=false even with
 *      obviously-empty arrays (e.g. empty Tags on S3).
 *   6. Populated required fields: isSkeletal=false, no advisories.
 *   7. Multiple empty required fields → one advisory per field.
 *   8. Advisory shape: `code`, `message`, `hint`, and `details`
 *      with stable structured payload.
 */

import { describe, it, expect } from "vitest";
import { detectSkeletalPlan } from "./skeletal-plan-detector.js";
import { RESOURCE_TYPES } from "@/index.js";

describe("detectSkeletalPlan (e98.W5.N5)", () => {
  describe("C-N3 — RDS DBInstance", () => {
    it("flags empty VPCSecurityGroups as skeletal", () => {
      const out = detectSkeletalPlan(RESOURCE_TYPES.RDS_DB_INSTANCE, {
        DBInstanceIdentifier: "my-db",
        Engine: "postgres",
        VPCSecurityGroups: [],
        DBSubnetGroupName: "my-subnet-group",
      });
      expect(out.isSkeletal).toBe(true);
      expect(out.emptyFields).toContain("VPCSecurityGroups");
      expect(out.advisories).toHaveLength(1);
      const advisory = out.advisories[0]!;
      expect(advisory.code).toBe("PLAN_SKELETAL");
      expect(advisory.message).toContain("VPCSecurityGroups");
      expect(advisory.message).toContain("must have at least 1 entry");
      expect(advisory.hint).toContain("--set VPCSecurityGroups");
      expect(advisory.details).toEqual({
        resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
        field: "VPCSecurityGroups",
        kind: "empty-array",
      });
    });

    it("flags missing DBSubnetGroupName (empty string)", () => {
      const out = detectSkeletalPlan(RESOURCE_TYPES.RDS_DB_INSTANCE, {
        DBInstanceIdentifier: "my-db",
        Engine: "postgres",
        VPCSecurityGroups: ["sg-0a1b2c3d4e5f67890"],
        DBSubnetGroupName: "",
      });
      expect(out.isSkeletal).toBe(true);
      expect(out.emptyFields).toContain("DBSubnetGroupName");
      const advisory = out.advisories[0]!;
      expect(advisory.hint).toContain("DBSubnetGroupName");
      expect(advisory.details!["kind"]).toBe("missing-string");
    });

    it("flags both empty VPCSecurityGroups AND missing DBSubnetGroupName (two advisories)", () => {
      const out = detectSkeletalPlan(RESOURCE_TYPES.RDS_DB_INSTANCE, {
        DBInstanceIdentifier: "my-db",
        Engine: "postgres",
        VPCSecurityGroups: [],
      });
      expect(out.isSkeletal).toBe(true);
      expect(out.emptyFields).toEqual(
        expect.arrayContaining(["VPCSecurityGroups", "DBSubnetGroupName"]),
      );
      expect(out.advisories).toHaveLength(2);
    });

    it("is clean when both required fields populated", () => {
      const out = detectSkeletalPlan(RESOURCE_TYPES.RDS_DB_INSTANCE, {
        DBInstanceIdentifier: "my-db",
        Engine: "postgres",
        VPCSecurityGroups: ["sg-0a1b2c3d4e5f67890"],
        DBSubnetGroupName: "my-subnet-group",
      });
      expect(out.isSkeletal).toBe(false);
      expect(out.emptyFields).toEqual([]);
      expect(out.advisories).toEqual([]);
    });
  });

  describe("C-N4 — ALB", () => {
    it("flags empty Subnets as skeletal with 2-AZ hint", () => {
      const out = detectSkeletalPlan(RESOURCE_TYPES.ELBV2_LOAD_BALANCER, {
        Name: "my-alb",
        Subnets: [],
        SecurityGroups: ["sg-0a1b2c3d"],
      });
      expect(out.isSkeletal).toBe(true);
      expect(out.emptyFields).toContain("Subnets");
      const advisory = out.advisories[0]!;
      expect(advisory.message).toContain("2 subnets");
      expect(advisory.hint).toContain("three-tier-web");
    });

    it("flags empty SecurityGroups as skeletal with ALB-vs-NLB hint", () => {
      const out = detectSkeletalPlan(RESOURCE_TYPES.ELBV2_LOAD_BALANCER, {
        Name: "my-alb",
        Subnets: ["subnet-a", "subnet-b"],
        SecurityGroups: [],
      });
      expect(out.isSkeletal).toBe(true);
      expect(out.emptyFields).toContain("SecurityGroups");
      expect(out.advisories[0]!.message).toContain(
        "Application Load Balancers require at least one SG",
      );
    });

    it("flags both empty arrays simultaneously", () => {
      const out = detectSkeletalPlan(RESOURCE_TYPES.ELBV2_LOAD_BALANCER, {
        Name: "my-alb",
        Subnets: [],
        SecurityGroups: [],
      });
      expect(out.isSkeletal).toBe(true);
      expect(out.emptyFields).toEqual(["Subnets", "SecurityGroups"]);
      expect(out.advisories).toHaveLength(2);
    });
  });

  describe("C-P3 — RDS DBSubnetGroup", () => {
    it("flags empty SubnetIds as skeletal", () => {
      const out = detectSkeletalPlan(RESOURCE_TYPES.RDS_DB_SUBNET_GROUP, {
        DBSubnetGroupName: "my-group",
        DBSubnetGroupDescription: "Test group",
        SubnetIds: [],
      });
      expect(out.isSkeletal).toBe(true);
      expect(out.emptyFields).toContain("SubnetIds");
      const advisory = out.advisories[0]!;
      expect(advisory.message).toContain("at least two subnets");
      expect(advisory.hint).toContain("three-tier-web");
    });
  });

  describe("non-allowlisted resource types", () => {
    it("S3::Bucket with empty Tags is NOT skeletal", () => {
      const out = detectSkeletalPlan(RESOURCE_TYPES.S3_BUCKET, {
        BucketName: "my-bucket",
        Tags: [],
      });
      expect(out.isSkeletal).toBe(false);
      expect(out.advisories).toEqual([]);
    });

    it("Lambda::Function with no fields is NOT skeletal", () => {
      const out = detectSkeletalPlan(RESOURCE_TYPES.LAMBDA_FUNCTION, {});
      expect(out.isSkeletal).toBe(false);
    });

    it("unknown resource type returns clean detection", () => {
      const out = detectSkeletalPlan("AWS::Fake::Resource", {});
      expect(out.isSkeletal).toBe(false);
      expect(out.emptyFields).toEqual([]);
      expect(out.advisories).toEqual([]);
    });
  });

  describe("empty-value detection edge cases", () => {
    it("treats undefined array as empty", () => {
      const out = detectSkeletalPlan(RESOURCE_TYPES.RDS_DB_INSTANCE, {
        DBInstanceIdentifier: "my-db",
        DBSubnetGroupName: "my-group",
        // VPCSecurityGroups intentionally absent
      });
      expect(out.emptyFields).toContain("VPCSecurityGroups");
    });

    it("treats null array as empty", () => {
      const out = detectSkeletalPlan(RESOURCE_TYPES.ELBV2_LOAD_BALANCER, {
        Name: "my-alb",
        Subnets: null,
        SecurityGroups: ["sg-0a1b2c3d"],
      });
      expect(out.emptyFields).toContain("Subnets");
    });

    it("treats non-array truthy value as empty (defensive)", () => {
      // If LLM emits a malformed shape (string instead of array), we
      // still flag it as skeletal — the CloudControl call will reject
      // it anyway, and the advisory gives a clearer diagnostic than
      // the AWS error will.
      const out = detectSkeletalPlan(RESOURCE_TYPES.ELBV2_LOAD_BALANCER, {
        Name: "my-alb",
        Subnets: "not-an-array" as unknown as string[],
        SecurityGroups: ["sg-0a1b2c3d"],
      });
      expect(out.emptyFields).toContain("Subnets");
    });

    it("treats whitespace-only string as missing", () => {
      const out = detectSkeletalPlan(RESOURCE_TYPES.RDS_DB_INSTANCE, {
        DBInstanceIdentifier: "my-db",
        VPCSecurityGroups: ["sg-0a1b2c3d"],
        DBSubnetGroupName: "   ",
      });
      expect(out.emptyFields).toContain("DBSubnetGroupName");
    });

    it("non-empty single-element array is NOT skeletal", () => {
      const out = detectSkeletalPlan(RESOURCE_TYPES.RDS_DB_INSTANCE, {
        DBInstanceIdentifier: "my-db",
        DBSubnetGroupName: "my-group",
        VPCSecurityGroups: ["sg-0a1b2c3d"],
      });
      expect(out.isSkeletal).toBe(false);
    });
  });

  describe("advisory shape", () => {
    it("every advisory has code='PLAN_SKELETAL' with stable payload", () => {
      const out = detectSkeletalPlan(RESOURCE_TYPES.ELBV2_LOAD_BALANCER, {
        Name: "my-alb",
        Subnets: [],
        SecurityGroups: [],
      });
      for (const advisory of out.advisories) {
        expect(advisory.code).toBe("PLAN_SKELETAL");
        expect(typeof advisory.message).toBe("string");
        expect(typeof advisory.hint).toBe("string");
        expect(advisory.details).toBeDefined();
        expect(advisory.details!["resourceType"]).toBe(
          RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
        );
        expect(advisory.details!["kind"]).toBe("empty-array");
      }
    });
  });
});
