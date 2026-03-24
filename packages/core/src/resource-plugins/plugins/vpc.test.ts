import { describe, it, expect } from "vitest";
import { vpcPlugin } from "./vpc.js";

describe("vpcPlugin", () => {
  it("has the correct resourceType", () => {
    expect(vpcPlugin.resourceType).toBe("AWS::EC2::VPC");
  });

  it("commonFields count is ≤10", () => {
    expect(vpcPlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count matches expected 4 fields", () => {
    expect(vpcPlugin.commonFields.length).toBe(4);
  });

  it("all commonField question types are valid QuestionType values", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of vpcPlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  it("CidrBlock field exists and is required", () => {
    const field = vpcPlugin.commonFields.find((f) => f.name === "CidrBlock");
    expect(field).toBeDefined();
    expect(field?.required).toBe(true);
    expect(field?.question.type).toBe("string");
    expect(field?.question.initialValue).toBe("10.0.0.0/16");
  });

  it("EnableDnsHostnames defaults to true", () => {
    const field = vpcPlugin.commonFields.find(
      (f) => f.name === "EnableDnsHostnames",
    );
    expect(field).toBeDefined();
    expect(field?.question.initialValue).toBe(true);
  });

  it("EnableDnsSupport defaults to true", () => {
    const field = vpcPlugin.commonFields.find(
      (f) => f.name === "EnableDnsSupport",
    );
    expect(field).toBeDefined();
    expect(field?.question.initialValue).toBe(true);
  });

  it("Tags field has toCfn transform", () => {
    const field = vpcPlugin.commonFields.find((f) => f.name === "Tags");
    expect(field).toBeDefined();
    expect(field?.toCfn).toBeDefined();
  });

  it("advancedFields contains InstanceTenancy", () => {
    const names = vpcPlugin.advancedFields.map((f) => f.name);
    expect(names).toContain("InstanceTenancy");
  });

  it("InstanceTenancy is enum with default/dedicated options", () => {
    const field = vpcPlugin.advancedFields.find(
      (f) => f.name === "InstanceTenancy",
    );
    expect(field?.question.type).toBe("enum");
    const values = field?.question.options?.map((o) => o.value);
    expect(values).toContain("default");
    expect(values).toContain("dedicated");
  });

  it("defaults contain expected values", () => {
    expect(vpcPlugin.defaults["CidrBlock"]).toBe("10.0.0.0/16");
    expect(vpcPlugin.defaults["EnableDnsHostnames"]).toBe(true);
    expect(vpcPlugin.defaults["EnableDnsSupport"]).toBe(true);
    expect(vpcPlugin.defaults["InstanceTenancy"]).toBe("default");
  });

  it("has configHints", () => {
    expect(vpcPlugin.configHints).toBeDefined();
    expect(vpcPlugin.configHints!.length).toBeGreaterThan(0);
  });

  describe("CidrBlock validation", () => {
    const field = vpcPlugin.commonFields.find((f) => f.name === "CidrBlock")!;

    it("accepts valid CIDR", () => {
      expect(field.question.validate?.("10.0.0.0/16")).toBeUndefined();
    });

    it("accepts /24 CIDR", () => {
      expect(field.question.validate?.("10.0.1.0/24")).toBeUndefined();
    });

    it("rejects invalid format", () => {
      expect(field.question.validate?.("not-a-cidr")).toBeDefined();
    });

    it("rejects prefix smaller than /16", () => {
      expect(field.question.validate?.("10.0.0.0/8")).toBeDefined();
    });

    it("rejects prefix larger than /28", () => {
      expect(field.question.validate?.("10.0.0.0/30")).toBeDefined();
    });

    it("accepts empty value", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });
  });

  describe("Tags toCfn transform", () => {
    const field = vpcPlugin.commonFields.find((f) => f.name === "Tags")!;

    it("transforms comma-separated pairs", () => {
      expect(field.toCfn!("env:production, team:platform")).toEqual([
        { Key: "env", Value: "production" },
        { Key: "team", Value: "platform" },
      ]);
    });

    it("returns undefined for empty string", () => {
      expect(field.toCfn!("")).toBeUndefined();
    });
  });
});
