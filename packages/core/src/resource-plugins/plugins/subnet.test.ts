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
    // Tier C: drop the toBeDefined() pre-check — using `!` at find time
    // makes the assertion fail naturally if the field disappears, AND
    // the subsequent property accesses become unconditional. The
    // previous `field?.required` form silently passed when field was
    // undefined.
    const field = subnetPlugin.commonFields.find((f) => f.name === "VpcId")!;
    expect(field).toMatchObject({
      name: "VpcId",
      required: true,
      question: {
        type: "enum",
        fetcher: "discover-vpcs",
      },
    });
  });

  it("CidrBlock field exists and is required", () => {
    // Tier C: strengthened — toMatchObject locks the full shape
    const field = subnetPlugin.commonFields.find(
      (f) => f.name === "CidrBlock",
    )!;
    expect(field).toMatchObject({
      name: "CidrBlock",
      required: true,
      question: { type: "string" },
    });
  });

  it("AvailabilityZone field uses discover-availability-zones fetcher", () => {
    // Tier C: strengthened
    const field = subnetPlugin.commonFields.find(
      (f) => f.name === "AvailabilityZone",
    )!;
    expect(field).toMatchObject({
      name: "AvailabilityZone",
      required: true,
      question: { fetcher: "discover-availability-zones" },
    });
  });

  it("MapPublicIpOnLaunch defaults to false", () => {
    // Tier C: strengthened
    const field = subnetPlugin.commonFields.find(
      (f) => f.name === "MapPublicIpOnLaunch",
    )!;
    expect(field).toMatchObject({
      name: "MapPublicIpOnLaunch",
      question: { initialValue: false },
    });
  });

  it("Tags field has callable toCfn transform", () => {
    // Tier C: strengthened — assert toCfn is actually a function (the
    // previous `toBeDefined()` would have passed for any non-undefined
    // value including a string or number, which is meaningless here).
    const field = subnetPlugin.commonFields.find((f) => f.name === "Tags")!;
    expect(field.name).toBe("Tags");
    expect(typeof field.toCfn).toBe("function");
  });

  it("advancedFields is empty", () => {
    expect(subnetPlugin.advancedFields).toHaveLength(0);
  });

  it("defaults contain MapPublicIpOnLaunch as false", () => {
    expect(subnetPlugin.defaults["MapPublicIpOnLaunch"]).toBe(false);
  });

  it("has at least 3 configHints (Tier C: was toBeDefined+>0)", () => {
    // Tier C: strengthened — meaningful floor instead of just "exists"
    expect(subnetPlugin.configHints).toBeInstanceOf(Array);
    expect(subnetPlugin.configHints!.length).toBeGreaterThanOrEqual(3);
  });

  describe("CidrBlock validation", () => {
    const field = subnetPlugin.commonFields.find(
      (f) => f.name === "CidrBlock",
    )!;

    it("accepts valid subnet CIDR", () => {
      expect(field.question.validate?.("10.0.1.0/24")).toBeUndefined();
    });

    it("rejects empty value with 'required' error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("")).toBe(
        "Subnet CIDR block is required",
      );
    });

    it("rejects invalid format with CIDR-notation error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("not-a-cidr")).toBe(
        "Must be valid CIDR notation (e.g. 10.0.1.0/24)",
      );
    });

    it("rejects prefix smaller than /16 with prefix-range error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("10.0.0.0/8")).toBe(
        "Subnet CIDR prefix must be between /16 and /28",
      );
    });

    it("rejects prefix larger than /28 with prefix-range error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("10.0.0.0/30")).toBe(
        "Subnet CIDR prefix must be between /16 and /28",
      );
    });

    it("accepts /16 (lower boundary)", () => {
      // Tier C: new boundary test
      expect(field.question.validate?.("10.0.0.0/16")).toBeUndefined();
    });

    it("accepts /28 (upper boundary)", () => {
      // Tier C: new boundary test
      expect(field.question.validate?.("10.0.0.0/28")).toBeUndefined();
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
