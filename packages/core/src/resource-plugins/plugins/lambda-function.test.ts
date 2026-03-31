import { describe, it, expect } from "vitest";
import { lambdaFunctionPlugin } from "./lambda-function.js";

describe("lambdaFunctionPlugin", () => {
  // ── Task 5 / AC #5: FunctionName and Role required ─────────────────────

  it("marks FunctionName as required", () => {
    const field = lambdaFunctionPlugin.commonFields.find(
      (f) => f.name === "FunctionName",
    );
    expect(field).toBeDefined();
    expect(field!.required).toBe(true);
  });

  it("marks Role as required", () => {
    const field = lambdaFunctionPlugin.commonFields.find(
      (f) => f.name === "Role",
    );
    expect(field).toBeDefined();
    expect(field!.required).toBe(true);
  });

  // ── Task 2 / AC #2: Runtime enum has 8 options ─────────────────────────

  it("has 8 runtime options including new runtimes", () => {
    const runtimeField = lambdaFunctionPlugin.commonFields.find(
      (f) => f.name === "Runtime",
    );
    expect(runtimeField).toBeDefined();
    const options = runtimeField!.question.options!;
    expect(options).toHaveLength(8);

    const values = options.map((o) => o.value);
    expect(values).toContain("dotnet8");
    expect(values).toContain("ruby3.3");
    expect(values).toContain("provided.al2023");
    expect(values).toContain("nodejs22.x");
    expect(values).toContain("nodejs20.x");
    expect(values).toContain("python3.13");
    expect(values).toContain("python3.12");
    expect(values).toContain("java21");
  });

  // ── Task 1 / AC #1: Environment field with toCfn ───────────────────────

  describe("Environment field", () => {
    const envField = lambdaFunctionPlugin.commonFields.find(
      (f) => f.name === "Environment",
    );

    it("exists in commonFields with correct type and placeholder", () => {
      expect(envField).toBeDefined();
      expect(envField!.question.type).toBe("string");
      expect(envField!.question.placeholder).toBe("KEY1=value1,KEY2=value2");
    });

    it("toCfn transforms comma-separated pairs to Variables object", () => {
      const result = envField!.toCfn!("DB_HOST=localhost,API_KEY=abc123");
      expect(result).toEqual({
        Variables: {
          DB_HOST: "localhost",
          API_KEY: "abc123",
        },
      });
    });

    it("toCfn returns undefined for empty string", () => {
      expect(envField!.toCfn!("")).toBeUndefined();
      expect(envField!.toCfn!("  ")).toBeUndefined();
    });

    it("toCfn returns undefined for falsy values", () => {
      expect(envField!.toCfn!(null)).toBeUndefined();
      expect(envField!.toCfn!(undefined)).toBeUndefined();
    });

    it("toCfn preserves everything after first = in value", () => {
      const result = envField!.toCfn!("API_KEY=abc=def=ghi");
      expect(result).toEqual({
        Variables: {
          API_KEY: "abc=def=ghi",
        },
      });
    });

    it("toCfn skips malformed pairs without =", () => {
      const result = envField!.toCfn!("GOOD=value,BADPAIR,ALSO_GOOD=yes");
      expect(result).toEqual({
        Variables: {
          GOOD: "value",
          ALSO_GOOD: "yes",
        },
      });
    });

    it("toCfn returns undefined if all pairs are malformed", () => {
      expect(envField!.toCfn!("noeq,another")).toBeUndefined();
    });

    it("toCfn trims whitespace from keys and values", () => {
      const result = envField!.toCfn!(" KEY1 = value1 , KEY2 = value2 ");
      expect(result).toEqual({
        Variables: {
          KEY1: "value1",
          KEY2: "value2",
        },
      });
    });
  });

  // ── Story 18.11: Tags field ──────────────────────────────────────────────

  it("Tags field is string type with toCfn transform", () => {
    const field = lambdaFunctionPlugin.commonFields.find(
      (f) => f.name === "Tags",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("string");
    expect(field?.toCfn).toBeDefined();
  });

  // ── Story 18.11: FunctionName validation ─────────────────────────────────

  describe("FunctionName validation", () => {
    const field = lambdaFunctionPlugin.commonFields.find(
      (f) => f.name === "FunctionName",
    )!;

    it("accepts valid function name", () => {
      expect(field.question.validate?.("my-function_123")).toBeUndefined();
    });

    it("rejects empty value (required field)", () => {
      expect(field.question.validate?.("")).toBe("Function name is required");
    });

    it("rejects names longer than 64 chars", () => {
      expect(field.question.validate?.("a".repeat(65))).toBeDefined();
    });

    it("rejects names with special characters", () => {
      expect(field.question.validate?.("my.function")).toBeDefined();
      expect(field.question.validate?.("my function")).toBeDefined();
    });
  });

  // ── Story 18.11: Handler validation ──────────────────────────────────────

  describe("Handler validation", () => {
    const field = lambdaFunctionPlugin.commonFields.find(
      (f) => f.name === "Handler",
    )!;

    it("accepts valid handler", () => {
      expect(field.question.validate?.("index.handler")).toBeUndefined();
    });

    it("accepts empty value", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("rejects handler without dot", () => {
      expect(field.question.validate?.("handler")).toBeDefined();
    });
  });

  describe("configHints", () => {
    it("has configHints defined", () => {
      expect(lambdaFunctionPlugin.configHints).toBeDefined();
      expect(lambdaFunctionPlugin.configHints!.length).toBeGreaterThan(0);
    });

    it("includes guidance about Lambda Runtime", () => {
      const hints = lambdaFunctionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/Runtime/i);
      expect(hints).toMatch(/deprecated/i);
    });

    it("includes guidance about Role ARN", () => {
      const hints = lambdaFunctionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/Role/);
      expect(hints).toMatch(/OMIT/i);
    });

    it("includes guidance about Environment Variables", () => {
      const hints = lambdaFunctionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/Environment/i);
      expect(hints).toMatch(/Variables/i);
    });

    it("includes guidance about Architectures", () => {
      const hints = lambdaFunctionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/Architectures/i);
      expect(hints).toMatch(/arm64/i);
    });

    it("includes guidance about VpcConfig", () => {
      const hints = lambdaFunctionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/VpcConfig/i);
    });

    it("includes guidance about Layers", () => {
      const hints = lambdaFunctionPlugin.configHints!.join(" ");
      expect(hints).toMatch(/Layers/i);
      expect(hints).toMatch(/ARN/i);
    });
  });
});
