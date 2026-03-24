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
    const field = routePlugin.commonFields.find(
      (f) => f.name === "RouteTableId",
    );
    expect(field).toBeDefined();
    expect(field?.required).toBe(true);
    expect(field?.question.type).toBe("string");
  });

  it("DestinationCidrBlock field has default 0.0.0.0/0", () => {
    const field = routePlugin.commonFields.find(
      (f) => f.name === "DestinationCidrBlock",
    );
    expect(field).toBeDefined();
    expect(field?.required).toBe(true);
    expect(field?.question.initialValue).toBe("0.0.0.0/0");
  });

  it("RouteType field is enum with public/private options", () => {
    const field = routePlugin.commonFields.find((f) => f.name === "RouteType");
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("enum");
    const values = field?.question.options?.map((o) => o.value);
    expect(values).toContain("public");
    expect(values).toContain("private");
  });

  describe("showIf conditions", () => {
    it("GatewayId is shown when RouteType is public", () => {
      const field = routePlugin.commonFields.find(
        (f) => f.name === "GatewayId",
      );
      expect(field).toBeDefined();
      expect(field?.question.showIf).toEqual({
        field: "RouteType",
        value: "public",
      });
    });

    it("NatGatewayId is shown when RouteType is private", () => {
      const field = routePlugin.commonFields.find(
        (f) => f.name === "NatGatewayId",
      );
      expect(field).toBeDefined();
      expect(field?.question.showIf).toEqual({
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

  it("has configHints", () => {
    expect(routePlugin.configHints).toBeDefined();
    expect(routePlugin.configHints!.length).toBeGreaterThan(0);
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
