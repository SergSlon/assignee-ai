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

  it("VpcId field exists and is required", () => {
    const field = routeTablePlugin.commonFields.find((f) => f.name === "VpcId");
    expect(field).toBeDefined();
    expect(field?.required).toBe(true);
    expect(field?.question.type).toBe("enum");
  });

  it("VpcId field has discover-vpcs fetcher", () => {
    const field = routeTablePlugin.commonFields.find((f) => f.name === "VpcId");
    expect(field?.question.fetcher).toBe("discover-vpcs");
  });

  it("Tags field exists", () => {
    const field = routeTablePlugin.commonFields.find((f) => f.name === "Tags");
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("string");
  });

  it("advancedFields is empty", () => {
    expect(routeTablePlugin.advancedFields).toEqual([]);
  });

  it("defaults is empty", () => {
    expect(routeTablePlugin.defaults).toEqual({});
  });

  it("has configHints", () => {
    expect(routeTablePlugin.configHints).toBeDefined();
    expect(routeTablePlugin.configHints!.length).toBeGreaterThan(0);
  });

  it("configHints mention SubnetRouteTableAssociation immutability", () => {
    const hints = routeTablePlugin.configHints!.join(" ");
    expect(hints).toContain("SubnetRouteTableAssociation");
    expect(hints).toContain("IMMUTABLE");
  });

  it("has toCfn method", () => {
    expect(routeTablePlugin.toCfn).toBeDefined();
    expect(typeof routeTablePlugin.toCfn).toBe("function");
  });

  describe("Tags toCfn transform", () => {
    const field = routeTablePlugin.commonFields.find((f) => f.name === "Tags")!;

    it("Tags field has toCfn transform", () => {
      expect(field.toCfn).toBeDefined();
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
