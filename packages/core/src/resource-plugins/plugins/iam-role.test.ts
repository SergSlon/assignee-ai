import { describe, it, expect } from "vitest";
import { iamRolePlugin } from "./iam-role.js";

describe("iamRolePlugin", () => {
  it("has the correct resourceType", () => {
    expect(iamRolePlugin.resourceType).toBe("AWS::IAM::Role");
  });

  it("commonFields count is ≤10", () => {
    expect(iamRolePlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count is 6", () => {
    expect(iamRolePlugin.commonFields.length).toBe(6);
  });

  it("all commonField question types are valid", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of iamRolePlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  describe("RoleName validation", () => {
    const field = iamRolePlugin.commonFields.find(
      (f) => f.name === "RoleName",
    )!;

    it("accepts empty value (auto-generated)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid role name", () => {
      expect(field.question.validate?.("my-app-role")).toBeUndefined();
    });

    it("rejects names longer than 64 chars", () => {
      expect(field.question.validate?.("a".repeat(65))).toBeDefined();
    });

    it("rejects names with invalid characters", () => {
      expect(field.question.validate?.("my role!")).toBeDefined();
    });
  });

  it("AssumeRolePolicyDocument is required enum with 3 options", () => {
    const field = iamRolePlugin.commonFields.find(
      (f) => f.name === "AssumeRolePolicyDocument",
    );
    expect(field?.required).toBe(true);
    expect(field?.question.type).toBe("enum");
    expect(field?.question.options).toHaveLength(3);
  });

  describe("AssumeRolePolicyDocument toCfn transform", () => {
    const field = iamRolePlugin.commonFields.find(
      (f) => f.name === "AssumeRolePolicyDocument",
    )!;

    it("transforms 'lambda' to Lambda trust policy", () => {
      const result = field.toCfn!("lambda") as Record<string, unknown>;
      expect(result).toHaveProperty("Version", "2012-10-17");
      const statements = result["Statement"] as Array<Record<string, unknown>>;
      expect(statements[0]?.["Principal"]).toEqual({
        Service: "lambda.amazonaws.com",
      });
    });

    it("transforms 'ec2' to EC2 trust policy", () => {
      const result = field.toCfn!("ec2") as Record<string, unknown>;
      const statements = result["Statement"] as Array<Record<string, unknown>>;
      expect(statements[0]?.["Principal"]).toEqual({
        Service: "ec2.amazonaws.com",
      });
    });

    it("transforms 'ecs' to ECS trust policy", () => {
      const result = field.toCfn!("ecs") as Record<string, unknown>;
      const statements = result["Statement"] as Array<Record<string, unknown>>;
      expect(statements[0]?.["Principal"]).toEqual({
        Service: "ecs-tasks.amazonaws.com",
      });
    });
  });

  describe("MaxSessionDuration toCfn", () => {
    const field = iamRolePlugin.commonFields.find(
      (f) => f.name === "MaxSessionDuration",
    )!;

    it("converts string to number", () => {
      expect(field.toCfn!("7200")).toBe(7200);
    });
  });

  it("Tags field has toCfn transform", () => {
    const field = iamRolePlugin.commonFields.find((f) => f.name === "Tags");
    expect(field?.toCfn).toBeDefined();
  });

  it("advancedFields contains ManagedPolicyArns", () => {
    const names = iamRolePlugin.advancedFields.map((f) => f.name);
    expect(names).toContain("ManagedPolicyArns");
  });

  it("commonFields contains PermissionsBoundary", () => {
    const names = iamRolePlugin.commonFields.map((f) => f.name);
    expect(names).toContain("PermissionsBoundary");
  });

  describe("ManagedPolicyArns toCfn transform", () => {
    const field = iamRolePlugin.advancedFields.find(
      (f) => f.name === "ManagedPolicyArns",
    )!;

    it("splits comma-separated ARNs into array", () => {
      const input =
        "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess, arn:aws:iam::aws:policy/CloudWatchLogsFullAccess";
      const result = field.toCfn!(input);
      expect(result).toEqual([
        "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess",
        "arn:aws:iam::aws:policy/CloudWatchLogsFullAccess",
      ]);
    });

    it("returns undefined for empty string", () => {
      expect(field.toCfn!("")).toBeUndefined();
    });
  });

  it("has configHints about AdminAccess and least privilege", () => {
    expect(iamRolePlugin.configHints).toBeDefined();
    expect(iamRolePlugin.configHints!.length).toBeGreaterThan(0);
    const hints = iamRolePlugin.configHints!.join(" ");
    expect(hints).toContain("AdministratorAccess");
  });

  it("defaults include MaxSessionDuration", () => {
    expect(iamRolePlugin.defaults).toEqual({ MaxSessionDuration: 3600 });
  });
});
