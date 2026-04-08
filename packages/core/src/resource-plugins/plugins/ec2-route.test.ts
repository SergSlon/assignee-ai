import { describe, it, expect } from "vitest";
import { routePlugin } from "./ec2-route.js";

describe("routePlugin", () => {
  it("has the correct resourceType", () => {
    expect(routePlugin.resourceType).toBe("AWS::EC2::Route");
  });

  it("commonFields count is <=10", () => {
    expect(routePlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count matches expected 5 fields", () => {
    expect(routePlugin.commonFields.length).toBe(5);
  });

  it("all commonField question types are valid QuestionType values", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of routePlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  it("RouteTableId field exists and is required", () => {
    // Tier C: strengthened — find!() + toMatchObject
    const field = routePlugin.commonFields.find(
      (f) => f.name === "RouteTableId",
    )!;
    expect(field).toMatchObject({
      name: "RouteTableId",
      required: true,
      question: { type: "string" },
    });
  });

  it("DestinationCidrBlock field has default 0.0.0.0/0", () => {
    // Tier C: strengthened
    const field = routePlugin.commonFields.find(
      (f) => f.name === "DestinationCidrBlock",
    )!;
    expect(field).toMatchObject({
      name: "DestinationCidrBlock",
      required: true,
      question: { initialValue: "0.0.0.0/0" },
    });
  });

  it("RouteType field is enum with public/private options", () => {
    // Tier C: strengthened
    const field = routePlugin.commonFields.find((f) => f.name === "RouteType")!;
    expect(field.question.type).toBe("enum");
    const values = field.question.options!.map((o) => o.value);
    expect(values).toEqual(["public", "private"]);
  });

  describe("showIf conditions", () => {
    it("GatewayId is shown when RouteType is public", () => {
      // Tier C: strengthened
      const field = routePlugin.commonFields.find(
        (f) => f.name === "GatewayId",
      )!;
      expect(field.question.showIf).toEqual({
        field: "RouteType",
        value: "public",
      });
    });

    it("NatGatewayId is shown when RouteType is private", () => {
      // Tier C: strengthened
      const field = routePlugin.commonFields.find(
        (f) => f.name === "NatGatewayId",
      )!;
      expect(field.question.showIf).toEqual({
        field: "RouteType",
        value: "private",
      });
    });

    it("GatewayId and NatGatewayId are mutually exclusive via showIf", () => {
      const gatewayField = routePlugin.commonFields.find(
        (f) => f.name === "GatewayId",
      );
      const natField = routePlugin.commonFields.find(
        (f) => f.name === "NatGatewayId",
      );
      // Both depend on RouteType but with different values
      expect(gatewayField?.question.showIf?.field).toBe("RouteType");
      expect(natField?.question.showIf?.field).toBe("RouteType");
      expect(gatewayField?.question.showIf?.value).not.toBe(
        natField?.question.showIf?.value,
      );
    });
  });

  it("advancedFields is empty", () => {
    expect(routePlugin.advancedFields).toEqual([]);
  });

  it("defaults contain expected values", () => {
    expect(routePlugin.defaults["DestinationCidrBlock"]).toBe("0.0.0.0/0");
    expect(routePlugin.defaults["RouteType"]).toBe("public");
  });

  it("has at least 3 configHints (Tier C: was toBeDefined+>0)", () => {
    // Tier C: strengthened — meaningful floor
    expect(routePlugin.configHints).toBeInstanceOf(Array);
    expect(routePlugin.configHints!.length).toBeGreaterThanOrEqual(3);
  });

  it("configHints mention target exclusivity", () => {
    const hints = routePlugin.configHints!.join(" ");
    expect(hints).toContain("exactly one target");
  });

  it("configHints mention GatewayId and NatGatewayId", () => {
    const hints = routePlugin.configHints!.join(" ");
    expect(hints).toContain("GatewayId");
    expect(hints).toContain("NatGatewayId");
  });
});
