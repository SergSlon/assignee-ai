import { describe, it, expect } from "vitest";
import { apiGatewayV2Plugin } from "./apigatewayv2-api.js";

describe("apiGatewayV2Plugin", () => {
  it("has the correct resourceType", () => {
    expect(apiGatewayV2Plugin.resourceType).toBe("AWS::ApiGatewayV2::Api");
  });

  it("commonFields count is ≤10", () => {
    expect(apiGatewayV2Plugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count matches expected 9 fields", () => {
    expect(apiGatewayV2Plugin.commonFields.length).toBe(9);
  });

  it("commonFields contains expected field names", () => {
    const names = apiGatewayV2Plugin.commonFields.map((f) => f.name);
    expect(names).toContain("Name");
    expect(names).toContain("ProtocolType");
    expect(names).toContain("Description");
    expect(names).toContain("EnableCors");
    expect(names).toContain("CorsAllowOrigins");
    expect(names).toContain("CorsAllowMethods");
    expect(names).toContain("CorsAllowHeaders");
    expect(names).toContain("DisableExecuteApiEndpoint");
    expect(names).toContain("Tags");
  });

  it("all commonField question types are valid QuestionType values", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of apiGatewayV2Plugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  it("Name field is required", () => {
    const field = apiGatewayV2Plugin.commonFields.find(
      (f) => f.name === "Name",
    );
    expect(field).toBeDefined();
    expect(field?.required).toBe(true);
    expect(field?.question.type).toBe("string");
  });

  describe("Name validation", () => {
    const field = apiGatewayV2Plugin.commonFields.find(
      (f) => f.name === "Name",
    )!;

    it("rejects empty value", () => {
      expect(field.question.validate?.("")).toBeDefined();
    });

    it("accepts valid API name", () => {
      expect(field.question.validate?.("my-http-api")).toBeUndefined();
    });

    it("rejects name longer than 128 characters", () => {
      expect(field.question.validate?.("a".repeat(129))).toBeDefined();
    });
  });

  it("ProtocolType field is enum with HTTP and WEBSOCKET options", () => {
    const field = apiGatewayV2Plugin.commonFields.find(
      (f) => f.name === "ProtocolType",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("enum");
    const values = field?.question.options?.map((o) => o.value);
    expect(values).toContain("HTTP");
    expect(values).toContain("WEBSOCKET");
  });

  it("ProtocolType defaults to HTTP", () => {
    const field = apiGatewayV2Plugin.commonFields.find(
      (f) => f.name === "ProtocolType",
    );
    expect(field?.question.initialValue).toBe("HTTP");
  });

  it("defaults contain ProtocolType: HTTP", () => {
    expect(apiGatewayV2Plugin.defaults["ProtocolType"]).toBe("HTTP");
  });

  it("DisableExecuteApiEndpoint defaults to false", () => {
    const field = apiGatewayV2Plugin.commonFields.find(
      (f) => f.name === "DisableExecuteApiEndpoint",
    );
    expect(field?.question.type).toBe("boolean");
    expect(field?.question.initialValue).toBe(false);
  });

  it("CORS sub-fields have showIf on EnableCors", () => {
    const corsFields = [
      "CorsAllowOrigins",
      "CorsAllowMethods",
      "CorsAllowHeaders",
    ];
    for (const name of corsFields) {
      const field = apiGatewayV2Plugin.commonFields.find(
        (f) => f.name === name,
      );
      expect(field?.question.showIf).toEqual({
        field: "EnableCors",
        value: true,
      });
    }
  });

  it("advancedFields contains RouteSelectionExpression and Version", () => {
    const names = apiGatewayV2Plugin.advancedFields.map((f) => f.name);
    expect(names).toContain("RouteSelectionExpression");
    expect(names).toContain("Version");
  });

  it("RouteSelectionExpression has correct default", () => {
    const field = apiGatewayV2Plugin.advancedFields.find(
      (f) => f.name === "RouteSelectionExpression",
    );
    expect(field?.question.initialValue).toBe("$request.method $request.path");
  });

  it("Tags field is string type with toCfn transform", () => {
    const field = apiGatewayV2Plugin.commonFields.find(
      (f) => f.name === "Tags",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("string");
    expect(field?.toCfn).toBeDefined();
  });

  describe("Tags toCfn transform", () => {
    const field = apiGatewayV2Plugin.commonFields.find(
      (f) => f.name === "Tags",
    )!;

    it("transforms comma-separated key:value pairs to object", () => {
      expect(field.toCfn!("env:production, team:backend")).toEqual({
        env: "production",
        team: "backend",
      });
    });

    it("returns undefined for empty string", () => {
      expect(field.toCfn!("")).toBeUndefined();
    });
  });

  describe("CorsAllowOrigins toCfn transform", () => {
    const field = apiGatewayV2Plugin.commonFields.find(
      (f) => f.name === "CorsAllowOrigins",
    )!;

    it("transforms comma-separated origins to array", () => {
      expect(
        field.toCfn!("https://example.com, https://app.example.com"),
      ).toEqual(["https://example.com", "https://app.example.com"]);
    });

    it("returns undefined for empty string", () => {
      expect(field.toCfn!("")).toBeUndefined();
    });
  });

  it("configHints are present and non-empty", () => {
    expect(apiGatewayV2Plugin.configHints).toBeDefined();
    expect(apiGatewayV2Plugin.configHints!.length).toBeGreaterThanOrEqual(3);
  });

  it("configHints cover ProtocolType semantics", () => {
    const hints = apiGatewayV2Plugin.configHints!.join(" ");
    expect(hints).toMatch(/HTTP API/i);
    expect(hints).toMatch(/cheaper/i);
  });

  it("configHints cover CORS origin restriction", () => {
    const hints = apiGatewayV2Plugin.configHints!.join(" ");
    expect(hints).toMatch(/CORS/i);
    expect(hints).toMatch(/wildcard|\*/);
  });

  it("configHints cover route selection expression", () => {
    const hints = apiGatewayV2Plugin.configHints!.join(" ");
    expect(hints).toMatch(/route selection/i);
  });

  it("configHints recommend access logging via CloudWatch LogGroup", () => {
    const hints = apiGatewayV2Plugin.configHints!.join(" ");
    expect(hints).toMatch(/access log/i);
    expect(hints).toMatch(/LogGroup/i);
  });
});
