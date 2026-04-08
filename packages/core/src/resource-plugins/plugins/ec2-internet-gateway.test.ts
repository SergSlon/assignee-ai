import { describe, it, expect } from "vitest";
import { internetGatewayPlugin } from "./ec2-internet-gateway.js";

describe("internetGatewayPlugin", () => {
  it("has the correct resourceType", () => {
    expect(internetGatewayPlugin.resourceType).toBe(
      "AWS::EC2::InternetGateway",
    );
  });

  it("commonFields contains only Tags", () => {
    expect(internetGatewayPlugin.commonFields.length).toBe(1);
    expect(internetGatewayPlugin.commonFields[0]!.name).toBe("Tags");
  });

  it("commonFields count is <=10", () => {
    expect(internetGatewayPlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("all commonField question types are valid QuestionType values", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of internetGatewayPlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  it("advancedFields is empty", () => {
    expect(internetGatewayPlugin.advancedFields).toEqual([]);
  });

  it("defaults is empty", () => {
    expect(internetGatewayPlugin.defaults).toEqual({});
  });

  it("has at least 2 configHints (Tier C: was toBeDefined+>0)", () => {
    // Tier C: strengthened — meaningful floor
    expect(internetGatewayPlugin.configHints).toBeInstanceOf(Array);
    expect(internetGatewayPlugin.configHints!.length).toBeGreaterThanOrEqual(2);
  });

  it("configHints mention VPCGatewayAttachment", () => {
    const hints = internetGatewayPlugin.configHints!.join(" ");
    expect(hints).toContain("VPCGatewayAttachment");
  });

  it("configHints mention route table for public subnets", () => {
    const hints = internetGatewayPlugin.configHints!.join(" ");
    expect(hints).toContain("0.0.0.0/0");
  });

  describe("Tags toCfn transform", () => {
    const field = internetGatewayPlugin.commonFields.find(
      (f) => f.name === "Tags",
    )!;

    it("Tags field has callable toCfn transform", () => {
      // Tier C: strengthened — function-ness check
      expect(typeof field.toCfn).toBe("function");
    });

    it("transforms comma-separated pairs", () => {
      expect(field.toCfn!("env:production, team:platform")).toEqual([
        { Key: "env", Value: "production" },
        { Key: "team", Value: "platform" },
      ]);
    });

    it("returns undefined for empty string", () => {
      expect(field.toCfn!("")).toBeUndefined();
    });

    it("handles values containing colons", () => {
      expect(field.toCfn!("arn:aws:s3:::my-bucket")).toEqual([
        { Key: "arn", Value: "aws:s3:::my-bucket" },
      ]);
    });
  });
});
