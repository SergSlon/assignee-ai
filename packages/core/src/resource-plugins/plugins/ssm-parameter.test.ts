import { describe, it, expect } from "vitest";
import { ssmParameterPlugin } from "./ssm-parameter.js";

describe("ssmParameterPlugin", () => {
  it("has the correct resourceType", () => {
    expect(ssmParameterPlugin.resourceType).toBe("AWS::SSM::Parameter");
  });

  it("commonFields count is ≤10", () => {
    expect(ssmParameterPlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count is 5", () => {
    expect(ssmParameterPlugin.commonFields.length).toBe(5);
  });

  it("Name is required", () => {
    const field = ssmParameterPlugin.commonFields.find(
      (f) => f.name === "Name",
    );
    expect(field?.required).toBe(true);
  });

  describe("Name validation", () => {
    const field = ssmParameterPlugin.commonFields.find(
      (f) => f.name === "Name",
    )!;

    it("rejects empty value with 'required' error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("")).toBe("Parameter name is required");
    });

    it("accepts valid parameter name", () => {
      expect(
        field.question.validate?.("/my-app/config/db-host"),
      ).toBeUndefined();
    });

    it("rejects names not starting with / with prefix error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("no-slash")).toBe(
        "Parameter name must start with /",
      );
    });

    it("rejects names longer than 2048 chars with length error", () => {
      // Tier C: strengthened from toBeDefined() — 2048-char input creates
      // a 2049-char total (with the leading /), tripping the length check.
      expect(field.question.validate?.("/" + "a".repeat(2048))).toBe(
        "Parameter name must be 2048 characters or fewer",
      );
    });

    it("accepts exactly 2048 chars (boundary)", () => {
      // Tier C: new boundary test
      expect(field.question.validate?.("/" + "a".repeat(2047))).toBeUndefined();
    });
  });

  it("Type is a required enum with 3 options", () => {
    const field = ssmParameterPlugin.commonFields.find(
      (f) => f.name === "Type",
    );
    expect(field?.required).toBe(true);
    expect(field?.question.type).toBe("enum");
    expect(field?.question.options).toHaveLength(3);
  });

  it("Value is required", () => {
    const field = ssmParameterPlugin.commonFields.find(
      (f) => f.name === "Value",
    );
    expect(field?.required).toBe(true);
  });

  it("KmsKeyId has showIf on Type === SecureString", () => {
    const field = ssmParameterPlugin.advancedFields.find(
      (f) => f.name === "KmsKeyId",
    );
    expect(field?.question.showIf).toEqual({
      field: "Type",
      value: "SecureString",
    });
  });

  it("Tier is an enum with Standard and Advanced options", () => {
    const field = ssmParameterPlugin.advancedFields.find(
      (f) => f.name === "Tier",
    );
    expect(field?.question.type).toBe("enum");
    expect(field?.question.options).toHaveLength(2);
  });

  it("Tags field has callable toCfn transform", () => {
    // Tier C: strengthened — find!() + function-ness
    const field = ssmParameterPlugin.commonFields.find(
      (f) => f.name === "Tags",
    )!;
    expect(typeof field.toCfn).toBe("function");
  });

  it("defaults include Type and Tier", () => {
    expect(ssmParameterPlugin.defaults).toEqual({
      Type: "String",
      Tier: "Standard",
    });
  });
});
