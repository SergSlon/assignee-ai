/**
 * Tests for populateDefaultOptions — Wave-2 P1-7 (2026-04-14).
 *
 * Validates that `--no-wizard` mode re-evaluates conditional (showIf)
 * fields against the populated defaults instead of silently skipping
 * them. A required dependent field (e.g. RDS EngineVersion when Engine
 * has a default) must either receive a safe default or surface in
 * MissingRequiredFieldsError.
 */

import { describe, it, expect } from "vitest";
import { populateDefaultOptions } from "./wizard-helpers.js";
import { MissingRequiredFieldsError } from "@assignee/core";
import type { ResourceField, ResourcePlugin } from "@assignee/core";

function field(
  name: string,
  overrides: Partial<ResourceField> & {
    initialValue?: unknown;
    showIf?: { field: string; value?: unknown; pattern?: string };
    required?: boolean;
  } = {},
): ResourceField {
  const { initialValue, showIf, required, ...rest } = overrides;
  return {
    name,
    required,
    question: {
      type: "string",
      label: name,
      ...(initialValue !== undefined ? { initialValue } : {}),
      ...(showIf ? { showIf } : {}),
    },
    ...rest,
  } as ResourceField;
}

function plugin(
  commonFields: ResourceField[],
  defaults: Record<string, unknown> = {},
  advancedFields: ResourceField[] = [],
): ResourcePlugin {
  return {
    resourceType: "AWS::Test::Resource",
    commonFields,
    advancedFields,
    defaults,
  } as unknown as ResourcePlugin;
}

describe("populateDefaultOptions — conditional field handling", () => {
  it("populates top-level fields from plugin defaults", () => {
    const p = plugin([field("BucketName"), field("Region")], {
      BucketName: "my-bucket",
      Region: "us-east-1",
    });
    expect(populateDefaultOptions(p)).toEqual({
      BucketName: "my-bucket",
      Region: "us-east-1",
    });
  });

  it("prefers question.initialValue over plugin.defaults", () => {
    const p = plugin([field("Engine", { initialValue: "mysql" })], {
      Engine: "postgres",
    });
    expect(populateDefaultOptions(p)).toEqual({ Engine: "mysql" });
  });

  it("throws MissingRequiredFieldsError when top-level required lacks default", () => {
    const p = plugin([field("BucketName", { required: true })]);
    expect(() => populateDefaultOptions(p)).toThrow(MissingRequiredFieldsError);
  });

  describe("Wave-2 P1-7: showIf re-evaluation", () => {
    it("surfaces required dependent field when condition is true and no default exists", () => {
      // RDS-like: Engine has a default ("mysql"), EngineVersion is
      // required ONLY when Engine === "mysql". Previously skipped;
      // now should raise.
      const p = plugin(
        [
          field("Engine"),
          field("EngineVersion", {
            required: true,
            showIf: { field: "Engine", value: "mysql" },
          }),
        ],
        { Engine: "mysql" },
      );
      expect(() => populateDefaultOptions(p)).toThrow(
        MissingRequiredFieldsError,
      );
      try {
        populateDefaultOptions(p);
      } catch (err) {
        expect(err).toBeInstanceOf(MissingRequiredFieldsError);
        expect((err as MissingRequiredFieldsError).missingFields).toContain(
          "EngineVersion",
        );
      }
    });

    it("populates dependent field from plugin.defaults when condition is true", () => {
      const p = plugin(
        [
          field("Engine"),
          field("EngineVersion", {
            required: true,
            showIf: { field: "Engine", value: "mysql" },
          }),
        ],
        { Engine: "mysql", EngineVersion: "8.0.35" },
      );
      expect(populateDefaultOptions(p)).toEqual({
        Engine: "mysql",
        EngineVersion: "8.0.35",
      });
    });

    it("skips dependent field when showIf condition is false", () => {
      const p = plugin(
        [
          field("Engine"),
          field("EngineVersion", {
            required: true,
            showIf: { field: "Engine", value: "mysql" },
          }),
        ],
        { Engine: "postgres" },
      );
      // Engine is "postgres", so EngineVersion for mysql doesn't apply
      expect(populateDefaultOptions(p)).toEqual({ Engine: "postgres" });
    });

    it("aggregates ALL missing dependent fields into one error", () => {
      const p = plugin(
        [
          field("Engine"),
          field("EngineVersion", {
            required: true,
            showIf: { field: "Engine", value: "mysql" },
          }),
          field("CharacterSet", {
            required: true,
            showIf: { field: "Engine", value: "mysql" },
          }),
        ],
        { Engine: "mysql" },
      );
      try {
        populateDefaultOptions(p);
        throw new Error("expected MissingRequiredFieldsError");
      } catch (err) {
        expect(err).toBeInstanceOf(MissingRequiredFieldsError);
        const missing = (err as MissingRequiredFieldsError).missingFields;
        expect(missing).toContain("EngineVersion");
        expect(missing).toContain("CharacterSet");
      }
    });

    it("handles chained conditionals (A→B→C) to fixpoint", () => {
      // A = "x" (default), B showIf A==="x" gets default "y",
      // C showIf B==="y" is required with no default → must surface.
      const p = plugin(
        [
          field("A"),
          field("B", { showIf: { field: "A", value: "x" } }),
          field("C", {
            required: true,
            showIf: { field: "B", value: "y" },
          }),
        ],
        { A: "x", B: "y" },
      );
      expect(() => populateDefaultOptions(p)).toThrow(
        MissingRequiredFieldsError,
      );
    });

    it("re-evaluates pattern-based showIf (not just value-equality)", () => {
      const p = plugin(
        [
          field("Engine"),
          field("EngineVersion", {
            required: true,
            showIf: { field: "Engine", pattern: "^mysql" },
          }),
        ],
        { Engine: "mysql-community" },
      );
      expect(() => populateDefaultOptions(p)).toThrow(
        MissingRequiredFieldsError,
      );
    });

    it("non-required conditional field without default is silently omitted", () => {
      const p = plugin(
        [
          field("Engine"),
          field("OptionalTuning", {
            showIf: { field: "Engine", value: "mysql" },
          }),
        ],
        { Engine: "mysql" },
      );
      expect(populateDefaultOptions(p)).toEqual({ Engine: "mysql" });
    });

    it("advanced fields with showIf are also re-evaluated", () => {
      const p = plugin([field("Engine")], { Engine: "mysql" }, [
        field("EngineVersion", {
          required: true,
          showIf: { field: "Engine", value: "mysql" },
        }),
      ]);
      expect(() => populateDefaultOptions(p)).toThrow(
        MissingRequiredFieldsError,
      );
    });
  });
});
