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

    it("rejects empty value", () => {
      expect(field.question.validate?.("")).toBeDefined();
    });

    it("accepts valid parameter name", () => {
      expect(
        field.question.validate?.("/my-app/config/db-host"),
      ).toBeUndefined();
    });

    it("rejects names not starting with /", () => {
      expect(field.question.validate?.("no-slash")).toBeDefined();
    });

    it("rejects names longer than 2048 chars", () => {
      expect(field.question.validate?.("/" + "a".repeat(2048))).toBeDefined();
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

  it("Tags field has toCfn transform", () => {
    const field = ssmParameterPlugin.commonFields.find(
      (f) => f.name === "Tags",
    );
    expect(field?.toCfn).toBeDefined();
  });

  it("defaults include Type and Tier", () => {
    expect(ssmParameterPlugin.defaults).toEqual({
      Type: "String",
      Tier: "Standard",
    });
  });
});
