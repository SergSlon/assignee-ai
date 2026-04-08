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
    // Tier C: strengthened — find!() + toMatchObject
    const field = vpcPlugin.commonFields.find((f) => f.name === "CidrBlock")!;
    expect(field).toMatchObject({
      name: "CidrBlock",
      required: true,
      question: {
        type: "string",
        initialValue: "10.0.0.0/16",
      },
    });
  });

  it("EnableDnsHostnames defaults to true", () => {
    // Tier C: strengthened
    const field = vpcPlugin.commonFields.find(
      (f) => f.name === "EnableDnsHostnames",
    )!;
    expect(field).toMatchObject({
      name: "EnableDnsHostnames",
      question: { initialValue: true },
    });
  });

  it("EnableDnsSupport defaults to true", () => {
    // Tier C: strengthened
    const field = vpcPlugin.commonFields.find(
      (f) => f.name === "EnableDnsSupport",
    )!;
    expect(field).toMatchObject({
      name: "EnableDnsSupport",
      question: { initialValue: true },
    });
  });

  it("Tags field has callable toCfn transform", () => {
    // Tier C: strengthened — assert function-ness AND smoke-test the transform
    const field = vpcPlugin.commonFields.find((f) => f.name === "Tags")!;
    expect(typeof field.toCfn).toBe("function");
    expect(field.toCfn!("env:prod")).toEqual([{ Key: "env", Value: "prod" }]);
  });

  it("advancedFields contains InstanceTenancy", () => {
    const names = vpcPlugin.advancedFields.map((f) => f.name);
    expect(names).toContain("InstanceTenancy");
  });

  it("InstanceTenancy is enum with default/dedicated options", () => {
    // Tier C: strengthened — find!() so we don't silently pass on missing field
    const field = vpcPlugin.advancedFields.find(
      (f) => f.name === "InstanceTenancy",
    )!;
    expect(field.question.type).toBe("enum");
    const values = field.question.options!.map((o) => o.value);
    expect(values).toContain("default");
    expect(values).toContain("dedicated");
  });

  it("defaults contain expected values", () => {
    expect(vpcPlugin.defaults["CidrBlock"]).toBe("10.0.0.0/16");
    expect(vpcPlugin.defaults["EnableDnsHostnames"]).toBe(true);
    expect(vpcPlugin.defaults["EnableDnsSupport"]).toBe(true);
    expect(vpcPlugin.defaults["InstanceTenancy"]).toBe("default");
  });

  it("has at least 2 configHints (Tier C: was toBeDefined+>0)", () => {
    // Tier C: strengthened — meaningful floor instead of just "exists"
    expect(vpcPlugin.configHints).toBeInstanceOf(Array);
    expect(vpcPlugin.configHints!.length).toBeGreaterThanOrEqual(2);
  });

  describe("CidrBlock validation", () => {
    const field = vpcPlugin.commonFields.find((f) => f.name === "CidrBlock")!;

    it("accepts valid CIDR", () => {
      expect(field.question.validate?.("10.0.0.0/16")).toBeUndefined();
    });

    it("accepts /24 CIDR", () => {
      expect(field.question.validate?.("10.0.1.0/24")).toBeUndefined();
    });

    it("rejects invalid format with CIDR-notation error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("not-a-cidr")).toBe(
        "Must be valid CIDR notation (e.g. 10.0.0.0/16)",
      );
    });

    it("rejects prefix smaller than /16 with prefix-range error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("10.0.0.0/8")).toBe(
        "VPC CIDR prefix must be between /16 and /28",
      );
    });

    it("rejects prefix larger than /28 with prefix-range error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("10.0.0.0/30")).toBe(
        "VPC CIDR prefix must be between /16 and /28",
      );
    });

    it("accepts empty value", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts /16 (lower boundary)", () => {
      // Tier C: new boundary test
      expect(field.question.validate?.("10.0.0.0/16")).toBeUndefined();
    });

    it("accepts /28 (upper boundary)", () => {
      // Tier C: new boundary test
      expect(field.question.validate?.("10.0.0.0/28")).toBeUndefined();
    });

    it("rejects octet > 255 with invalid-IP error", () => {
      // Tier C: new — exercise the second validation branch
      expect(field.question.validate?.("10.0.300.0/16")).toBe(
        "Invalid IP address in CIDR",
      );
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
