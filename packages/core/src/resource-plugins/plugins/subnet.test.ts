import { describe, it, expect } from "vitest";
import { subnetPlugin } from "./subnet.js";

describe("subnetPlugin", () => {
  it("has the correct resourceType", () => {
    expect(subnetPlugin.resourceType).toBe("AWS::EC2::Subnet");
  });

  it("commonFields count is ≤10", () => {
    expect(subnetPlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count matches expected 5 fields", () => {
    expect(subnetPlugin.commonFields.length).toBe(5);
  });

  it("all commonField question types are valid QuestionType values", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of subnetPlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  it("VpcId field exists, is required, and uses discover-vpcs fetcher", () => {
    const field = subnetPlugin.commonFields.find((f) => f.name === "VpcId");
    expect(field).toBeDefined();
    expect(field?.required).toBe(true);
    expect(field?.question.type).toBe("enum");
    expect(field?.question.fetcher).toBe("discover-vpcs");
  });

  it("CidrBlock field exists and is required", () => {
    const field = subnetPlugin.commonFields.find((f) => f.name === "CidrBlock");
    expect(field).toBeDefined();
    expect(field?.required).toBe(true);
    expect(field?.question.type).toBe("string");
  });

  it("AvailabilityZone field uses discover-availability-zones fetcher", () => {
    const field = subnetPlugin.commonFields.find(
      (f) => f.name === "AvailabilityZone",
    );
    expect(field).toBeDefined();
    expect(field?.required).toBe(true);
    expect(field?.question.fetcher).toBe("discover-availability-zones");
  });

  it("MapPublicIpOnLaunch defaults to false", () => {
    const field = subnetPlugin.commonFields.find(
      (f) => f.name === "MapPublicIpOnLaunch",
    );
    expect(field).toBeDefined();
    expect(field?.question.initialValue).toBe(false);
  });

  it("Tags field has toCfn transform", () => {
    const field = subnetPlugin.commonFields.find((f) => f.name === "Tags");
    expect(field).toBeDefined();
    expect(field?.toCfn).toBeDefined();
  });

  it("advancedFields is empty", () => {
    expect(subnetPlugin.advancedFields).toHaveLength(0);
  });

  it("defaults contain MapPublicIpOnLaunch as false", () => {
    expect(subnetPlugin.defaults["MapPublicIpOnLaunch"]).toBe(false);
  });

  it("has configHints", () => {
    expect(subnetPlugin.configHints).toBeDefined();
    expect(subnetPlugin.configHints!.length).toBeGreaterThan(0);
  });

  describe("CidrBlock validation", () => {
    const field = subnetPlugin.commonFields.find(
      (f) => f.name === "CidrBlock",
    )!;

    it("accepts valid subnet CIDR", () => {
      expect(field.question.validate?.("10.0.1.0/24")).toBeUndefined();
    });

    it("rejects empty value (required)", () => {
      expect(field.question.validate?.("")).toBeDefined();
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
  });

  describe("Tags toCfn transform", () => {
    const field = subnetPlugin.commonFields.find((f) => f.name === "Tags")!;

    it("transforms comma-separated pairs", () => {
      expect(field.toCfn!("env:production, tier:public")).toEqual([
        { Key: "env", Value: "production" },
        { Key: "tier", Value: "public" },
      ]);
    });

    it("returns undefined for empty string", () => {
      expect(field.toCfn!("")).toBeUndefined();
    });
  });
});
