import { describe, it, expect } from "vitest";
import { routeTablePlugin } from "./ec2-route-table.js";

describe("routeTablePlugin", () => {
  it("has the correct resourceType", () => {
    expect(routeTablePlugin.resourceType).toBe("AWS::EC2::RouteTable");
  });

  it("commonFields count is <=10", () => {
    expect(routeTablePlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count matches expected 2 fields", () => {
    expect(routeTablePlugin.commonFields.length).toBe(2);
  });

  it("all commonField question types are valid QuestionType values", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of routeTablePlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  it("VpcId field exists, is required, and uses discover-vpcs fetcher", () => {
    // Tier C: collapsed two related tests + strengthened with toMatchObject
    const field = routeTablePlugin.commonFields.find(
      (f) => f.name === "VpcId",
    )!;
    expect(field).toMatchObject({
      name: "VpcId",
      required: true,
      question: { type: "enum", fetcher: "discover-vpcs" },
    });
  });

  it("Tags field exists", () => {
    // Tier C: strengthened — find!() + toMatchObject
    const field = routeTablePlugin.commonFields.find((f) => f.name === "Tags")!;
    expect(field).toMatchObject({
      name: "Tags",
      question: { type: "string" },
    });
  });

  it("advancedFields is empty", () => {
    expect(routeTablePlugin.advancedFields).toEqual([]);
  });

  it("defaults is empty", () => {
    expect(routeTablePlugin.defaults).toEqual({});
  });

  it("has at least 1 configHint (Tier C: was toBeDefined+>0)", () => {
    // Tier C: strengthened — meaningful floor
    expect(routeTablePlugin.configHints).toBeInstanceOf(Array);
    expect(routeTablePlugin.configHints!.length).toBeGreaterThanOrEqual(1);
  });

  it("configHints mention SubnetRouteTableAssociation immutability", () => {
    const hints = routeTablePlugin.configHints!.join(" ");
    expect(hints).toContain("SubnetRouteTableAssociation");
    expect(hints).toContain("IMMUTABLE");
  });

  it("has callable toCfn method", () => {
    // Tier C: strengthened — already had typeof check; drop the redundant
    // toBeDefined() pre-check.
    expect(typeof routeTablePlugin.toCfn).toBe("function");
  });

  describe("Tags toCfn transform", () => {
    const field = routeTablePlugin.commonFields.find((f) => f.name === "Tags")!;

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

  describe("toCfn()", () => {
    it("generates RouteTable resource with VpcId", () => {
      const result = routeTablePlugin.toCfn!({
        logicalId: "PublicRouteTable",
        VpcId: { Ref: "MyVpc" },
      });

      expect(Array.isArray(result)).toBe(true);
      const resources = result as Array<{
        logicalId: string;
        type: string;
        properties: Record<string, unknown>;
      }>;
      expect(resources.length).toBe(1);
      expect(resources[0]!.logicalId).toBe("PublicRouteTable");
      expect(resources[0]!.type).toBe("AWS::EC2::RouteTable");
      expect(resources[0]!.properties["VpcId"]).toEqual({ Ref: "MyVpc" });
    });

    it("generates both RouteTable and SubnetRouteTableAssociation when SubnetId is provided", () => {
      const result = routeTablePlugin.toCfn!({
        logicalId: "PublicRouteTable",
        VpcId: { Ref: "MyVpc" },
        SubnetId: { Ref: "PublicSubnet" },
      });

      expect(Array.isArray(result)).toBe(true);
      const resources = result as Array<{
        logicalId: string;
        type: string;
        properties: Record<string, unknown>;
      }>;
      expect(resources.length).toBe(2);

      // First resource: RouteTable
      expect(resources[0]!.type).toBe("AWS::EC2::RouteTable");
      expect(resources[0]!.properties["VpcId"]).toEqual({ Ref: "MyVpc" });

      // Second resource: SubnetRouteTableAssociation
      expect(resources[1]!.logicalId).toBe("PublicRouteTableSubnetAssociation");
      expect(resources[1]!.type).toBe("AWS::EC2::SubnetRouteTableAssociation");
      expect(resources[1]!.properties["RouteTableId"]).toEqual({
        Ref: "PublicRouteTable",
      });
      expect(resources[1]!.properties["SubnetId"]).toEqual({
        Ref: "PublicSubnet",
      });
    });

    it("includes Tags in RouteTable properties when provided", () => {
      const result = routeTablePlugin.toCfn!({
        logicalId: "MyRT",
        VpcId: "vpc-123",
        Tags: [{ Key: "env", Value: "prod" }],
      });

      const resources = result as Array<{
        logicalId: string;
        type: string;
        properties: Record<string, unknown>;
      }>;
      expect(resources[0]!.properties["Tags"]).toEqual([
        { Key: "env", Value: "prod" },
      ]);
    });

    it("omits Tags from RouteTable properties when not provided", () => {
      const result = routeTablePlugin.toCfn!({
        logicalId: "MyRT",
        VpcId: "vpc-123",
      });

      const resources = result as Array<{
        logicalId: string;
        type: string;
        properties: Record<string, unknown>;
      }>;
      expect(resources[0]!.properties["Tags"]).toBeUndefined();
    });

    it("uses fallback logicalId when not provided", () => {
      const result = routeTablePlugin.toCfn!({
        VpcId: "vpc-123",
      });

      const resources = result as Array<{
        logicalId: string;
        type: string;
        properties: Record<string, unknown>;
      }>;
      expect(resources[0]!.logicalId).toBe("RouteTable");
    });
  });
});
