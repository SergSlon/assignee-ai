import { describe, it, expect } from "vitest";
import { lambdaFunctionPlugin } from "./lambda-function.js";

describe("lambdaFunctionPlugin", () => {
  // ── Task 5 / AC #5: FunctionName and Role required ─────────────────────

  it("marks FunctionName as required", () => {
    const field = lambdaFunctionPlugin.commonFields.find(
      (f) => f.name === "FunctionName",
    );
    // Wave 16: strengthened — assert the field name explicitly so a
    // refactor that renames the field (e.g. to `functionName`) fails
    // here instead of producing a confusing `field!.required` access
    // on undefined later.
    expect(field?.name).toBe("FunctionName");
    expect(field!.required).toBe(true);
  });

  it("marks Role as required", () => {
    const field = lambdaFunctionPlugin.commonFields.find(
      (f) => f.name === "Role",
    );
    // Wave 16: strengthened — see FunctionName test above.
    expect(field?.name).toBe("Role");
    expect(field!.required).toBe(true);
  });

  // ── Task 2 / AC #2: Runtime enum has 8 options ─────────────────────────

  it("has 8 runtime options including new runtimes", () => {
    const runtimeField = lambdaFunctionPlugin.commonFields.find(
      (f) => f.name === "Runtime",
    );
    // Wave 16: strengthened — assert the field's name + question type
    // so a refactor that changes either fails here.
    expect(runtimeField?.name).toBe("Runtime");
    expect(runtimeField?.question.type).toBe("enum");
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
      // Wave 16: strengthened — assert envField is the right object
      // before chaining `.question.*` access.
      expect(envField?.name).toBe("Environment");
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
    // Wave 16: strengthened — assert field shape AND that toCfn is
    // actually a callable function (not just defined). The previous
    // `toBeDefined()` would have passed for any non-undefined value,
    // including a stringified function or a malformed object.
    expect(field?.name).toBe("Tags");
    expect(field?.question.type).toBe("string");
    expect(typeof field?.toCfn).toBe("function");
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
      // Wave 16: strengthened — validators MUST return a non-empty
      // string error message for invalid input. The previous
      // `toBeDefined()` would have passed for `0`, `false`, an empty
      // string, or any other non-undefined "falsy-ish" value, none
      // of which a wizard prompt could meaningfully display.
      const err = field.question.validate?.("a".repeat(65));
      expect(typeof err).toBe("string");
      expect((err as string).length).toBeGreaterThan(0);
    });

    it("rejects names with special characters", () => {
      // Wave 16: strengthened — see "rejects names longer than 64 chars".
      const errDot = field.question.validate?.("my.function");
      expect(typeof errDot).toBe("string");
      expect((errDot as string).length).toBeGreaterThan(0);

      const errSpace = field.question.validate?.("my function");
      expect(typeof errSpace).toBe("string");
      expect((errSpace as string).length).toBeGreaterThan(0);
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
      // Wave 16: strengthened — assert the validator returns a real
      // string error message, not just a non-undefined value.
      const err = field.question.validate?.("handler");
      expect(typeof err).toBe("string");
      expect((err as string).length).toBeGreaterThan(0);
    });
  });

  describe("configHints", () => {
    it("has configHints defined", () => {
      // Wave 16: dropped redundant `toBeDefined()` — `Array.isArray`
      // catches both null/undefined AND non-array shapes. The
      // `.length > 0` check below additionally requires a non-empty
      // array, which is the actual contract.
      expect(Array.isArray(lambdaFunctionPlugin.configHints)).toBe(true);
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
