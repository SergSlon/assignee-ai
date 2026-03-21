import { describe, it, expect } from "vitest";
import { lambdaFunctionPlugin } from "./lambda-function.js";

describe("lambdaFunctionPlugin", () => {
  it("has the correct resourceType", () => {
    expect(lambdaFunctionPlugin.resourceType).toBe("AWS::Lambda::Function");
  });

  it("commonFields count is ≤10 (AC-6)", () => {
    expect(lambdaFunctionPlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("all commonField question types are valid QuestionType values", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of lambdaFunctionPlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  it("Runtime is enum with nodejs22.x default", () => {
    const field = lambdaFunctionPlugin.commonFields.find(
      (f) => f.name === "Runtime",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("enum");
    expect(field?.question.initialValue).toBe("nodejs22.x");
    const values = field?.question.options?.map((o) => o.value) ?? [];
    expect(values).toContain("nodejs22.x");
    expect(values).toContain("python3.13");
  });

  it("Role validate rejects non-ARN values", () => {
    const field = lambdaFunctionPlugin.commonFields.find(
      (f) => f.name === "Role",
    );
    expect(field?.question.validate).toBeDefined();
    expect(field?.question.validate?.("not-an-arn")).toBeDefined();
    expect(field?.question.validate?.("")).toBeDefined();
  });

  it("Role validate accepts valid IAM role ARN", () => {
    const field = lambdaFunctionPlugin.commonFields.find(
      (f) => f.name === "Role",
    );
    expect(
      field?.question.validate?.(
        "arn:aws:iam::123456789012:role/my-lambda-role",
      ),
    ).toBeUndefined();
  });

  it("Timeout validate rejects out-of-range values", () => {
    const field = lambdaFunctionPlugin.commonFields.find(
      (f) => f.name === "Timeout",
    );
    expect(field?.question.validate).toBeDefined();
    expect(field?.question.validate?.("0")).toBeDefined();
    expect(field?.question.validate?.("901")).toBeDefined();
    expect(field?.question.validate?.("abc")).toBeDefined();
  });

  it("Timeout validate accepts values within 1–900 range", () => {
    const field = lambdaFunctionPlugin.commonFields.find(
      (f) => f.name === "Timeout",
    );
    expect(field?.question.validate?.("1")).toBeUndefined();
    expect(field?.question.validate?.("30")).toBeUndefined();
    expect(field?.question.validate?.("900")).toBeUndefined();
  });

  it("MemorySize is enum with 128 default", () => {
    const field = lambdaFunctionPlugin.commonFields.find(
      (f) => f.name === "MemorySize",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("enum");
    expect(field?.question.initialValue).toBe("128");
  });

  it("Tags field is multi type", () => {
    const field = lambdaFunctionPlugin.commonFields.find(
      (f) => f.name === "Tags",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("multi");
  });

  it("defaults contain MemorySize 128 and Timeout 30", () => {
    expect(lambdaFunctionPlugin.defaults["MemorySize"]).toBe(128);
    expect(lambdaFunctionPlugin.defaults["Timeout"]).toBe(30);
  });

  it("configHints references nodejs22.x and Role ARN guidance", () => {
    expect(lambdaFunctionPlugin.configHints).toBeDefined();
    expect(lambdaFunctionPlugin.configHints?.length).toBeGreaterThan(0);
    const joined = lambdaFunctionPlugin.configHints?.join(" ") ?? "";
    expect(joined).toContain("nodejs22.x");
    expect(joined).toContain("Role");
  });

  it("advancedFields contains Description and ReservedConcurrentExecutions", () => {
    const names = lambdaFunctionPlugin.advancedFields.map((f) => f.name);
    expect(names).toContain("Description");
    expect(names).toContain("ReservedConcurrentExecutions");
  });
});
