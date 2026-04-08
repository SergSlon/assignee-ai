import { describe, it, expect } from "vitest";
import { genericPlugin } from "./generic.js";

describe("genericPlugin", () => {
  it('resourceType is "generic" (not a real CloudFormation type)', () => {
    expect(genericPlugin.resourceType).toBe("generic");
    expect(genericPlugin.resourceType).not.toMatch(/^AWS::/);
  });

  it("has exactly 2 commonFields (AC-5)", () => {
    expect(genericPlugin.commonFields.length).toBe(2);
  });

  it("commonFields are ResourceName and Tags", () => {
    const names = genericPlugin.commonFields.map((f) => f.name);
    expect(names).toContain("ResourceName");
    expect(names).toContain("Tags");
  });

  it("ResourceName is a string type", () => {
    const field = genericPlugin.commonFields.find(
      (f) => f.name === "ResourceName",
    );
    expect(field?.question.type).toBe("string");
  });

  it("Tags is a string type with callable toCfn", () => {
    // Tier C: strengthened — find!() + function-ness
    const field = genericPlugin.commonFields.find((f) => f.name === "Tags")!;
    expect(field.question.type).toBe("string");
    expect(typeof field.toCfn).toBe("function");
  });

  it("advancedFields is empty (AC-5)", () => {
    expect(genericPlugin.advancedFields).toHaveLength(0);
  });

  it("defaults is empty object", () => {
    expect(genericPlugin.defaults).toEqual({});
  });
});
