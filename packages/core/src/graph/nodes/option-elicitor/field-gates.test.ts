/**
 * Unit tests for field-gates (Story 56-it2-03c).
 *
 * Covers every pre-prompt gate branch:
 *   - showIf unmet → skip
 *   - NEVER_ASK with value → inject + silent-default
 *   - NEVER_ASK with undefined value → silent-default, no mutation
 *   - ASK_IF_NOT_SET with prior answer → skip
 *   - ASK_IF_NOT_SET without prior answer → proceed
 *   - ALWAYS_ASK → proceed
 *   - quickMode + usable default (resolved.value) → inject + silent-default
 *   - quickMode + usable default (initialValue) → inject + silent-default
 *   - quickMode + usable default already in elicitedOptions → silent-default,
 *     no re-mutation
 *   - quickMode without usable default → proceed
 */

import { describe, it, expect } from "vitest";
import {
  applyFieldGates,
  hasUsableDefault,
  countVisible,
} from "./field-gates.js";
import { FieldPolicy } from "../../../constants/field-policy.js";
import type { ResourceField, ResolvedFieldConfig } from "../../../index.js";

function makeField(
  name: string,
  opts: {
    showIf?: { field: string; value: unknown };
    initialValue?: unknown;
  } = {},
): ResourceField {
  return {
    name,
    question: {
      type: "string",
      label: `Enter ${name}`,
      ...(opts.showIf ? { showIf: opts.showIf } : {}),
      ...(opts.initialValue !== undefined
        ? { initialValue: opts.initialValue }
        : {}),
    },
  };
}

function makeResolved(
  policy: ResolvedFieldConfig["policy"],
  value: unknown = undefined,
): ResolvedFieldConfig {
  return {
    policy,
    value,
    source: "plugin_default",
  };
}

describe("applyFieldGates", () => {
  it("returns skip when showIf condition is unmet", () => {
    const field = makeField("child", {
      showIf: { field: "parent", value: "yes" },
    });
    const res = makeResolved(FieldPolicy.ALWAYS_ASK);
    const elicitedOptions: Record<string, unknown> = { parent: "no" };

    const result = applyFieldGates(field, res, elicitedOptions, false);

    expect(result).toEqual({ kind: "skip" });
    expect(elicitedOptions["child"]).toBeUndefined();
  });

  it("returns proceed when showIf condition is met", () => {
    const field = makeField("child", {
      showIf: { field: "parent", value: "yes" },
    });
    const res = makeResolved(FieldPolicy.ALWAYS_ASK);
    const elicitedOptions: Record<string, unknown> = { parent: "yes" };

    const result = applyFieldGates(field, res, elicitedOptions, false);

    expect(result).toEqual({ kind: "proceed" });
  });

  it("injects resolved value and returns silent-default for NEVER_ASK with value", () => {
    const field = makeField("region");
    const res = makeResolved(FieldPolicy.NEVER_ASK, "us-east-1");
    const elicitedOptions: Record<string, unknown> = {};

    const result = applyFieldGates(field, res, elicitedOptions, false);

    expect(result).toEqual({ kind: "silent-default" });
    expect(elicitedOptions["region"]).toBe("us-east-1");
  });

  it("returns silent-default without mutation for NEVER_ASK with undefined value", () => {
    const field = makeField("region");
    const res = makeResolved(FieldPolicy.NEVER_ASK, undefined);
    const elicitedOptions: Record<string, unknown> = {};

    const result = applyFieldGates(field, res, elicitedOptions, false);

    expect(result).toEqual({ kind: "silent-default" });
    expect("region" in elicitedOptions).toBe(false);
  });

  it("returns skip for ASK_IF_NOT_SET when value already present", () => {
    const field = makeField("bucketName");
    const res = makeResolved(FieldPolicy.ASK_IF_NOT_SET);
    const elicitedOptions: Record<string, unknown> = {
      bucketName: "my-bucket",
    };

    const result = applyFieldGates(field, res, elicitedOptions, false);

    expect(result).toEqual({ kind: "skip" });
    expect(elicitedOptions["bucketName"]).toBe("my-bucket");
  });

  it("returns proceed for ASK_IF_NOT_SET when value missing", () => {
    const field = makeField("bucketName");
    const res = makeResolved(FieldPolicy.ASK_IF_NOT_SET);
    const elicitedOptions: Record<string, unknown> = {};

    const result = applyFieldGates(field, res, elicitedOptions, false);

    expect(result).toEqual({ kind: "proceed" });
  });

  it("returns proceed for ALWAYS_ASK without quickMode", () => {
    const field = makeField("tier");
    const res = makeResolved(FieldPolicy.ALWAYS_ASK);
    const elicitedOptions: Record<string, unknown> = {};

    const result = applyFieldGates(field, res, elicitedOptions, false);

    expect(result).toEqual({ kind: "proceed" });
  });

  it("quickMode + resolved.value injects and returns silent-default", () => {
    const field = makeField("storageClass");
    const res = makeResolved(FieldPolicy.ALWAYS_ASK, "STANDARD");
    const elicitedOptions: Record<string, unknown> = {};

    const result = applyFieldGates(field, res, elicitedOptions, true);

    expect(result).toEqual({ kind: "silent-default" });
    expect(elicitedOptions["storageClass"]).toBe("STANDARD");
  });

  it("quickMode + initialValue injects and returns silent-default", () => {
    const field = makeField("versioning", { initialValue: false });
    const res = makeResolved(FieldPolicy.ALWAYS_ASK, undefined);
    const elicitedOptions: Record<string, unknown> = {};

    const result = applyFieldGates(field, res, elicitedOptions, true);

    expect(result).toEqual({ kind: "silent-default" });
    expect(elicitedOptions["versioning"]).toBe(false);
  });

  it("quickMode + already-populated elicitedOptions keeps existing value", () => {
    const field = makeField("versioning", { initialValue: false });
    const res = makeResolved(FieldPolicy.ALWAYS_ASK, undefined);
    const elicitedOptions: Record<string, unknown> = { versioning: true };

    const result = applyFieldGates(field, res, elicitedOptions, true);

    expect(result).toEqual({ kind: "silent-default" });
    expect(elicitedOptions["versioning"]).toBe(true);
  });

  it("quickMode without usable default returns proceed", () => {
    const field = makeField("bucketName");
    const res = makeResolved(FieldPolicy.ALWAYS_ASK, undefined);
    const elicitedOptions: Record<string, unknown> = {};

    const result = applyFieldGates(field, res, elicitedOptions, true);

    expect(result).toEqual({ kind: "proceed" });
  });
});

describe("hasUsableDefault", () => {
  it("returns true when elicitedOptions already has a value", () => {
    const field = makeField("tier");
    const res = makeResolved(FieldPolicy.ALWAYS_ASK);
    expect(hasUsableDefault(field, res, { tier: "gold" })).toBe(true);
  });

  it("returns true when resolved.value is set", () => {
    const field = makeField("tier");
    const res = makeResolved(FieldPolicy.ALWAYS_ASK, "silver");
    expect(hasUsableDefault(field, res, {})).toBe(true);
  });

  it("returns true when question.initialValue is set", () => {
    const field = makeField("tier", { initialValue: "bronze" });
    const res = makeResolved(FieldPolicy.ALWAYS_ASK);
    expect(hasUsableDefault(field, res, {})).toBe(true);
  });

  it("returns false when no default is available anywhere", () => {
    const field = makeField("tier");
    const res = makeResolved(FieldPolicy.ALWAYS_ASK);
    expect(hasUsableDefault(field, res, {})).toBe(false);
  });
});

/**
 * Mirror of the fieldFetchKey convention used by the wizard pipeline —
 * fields with no showIf are keyed by bare name; fields with showIf get
 * a `name::parent=value` suffix so variants don't collide.
 */
function keyFor(field: ResourceField): string {
  const cond = field.question.showIf;
  if (!cond) return field.name;
  const suffix = cond.pattern ?? String(cond.value);
  return `${field.name}::${cond.field}=${suffix}`;
}

describe("countVisible", () => {
  it("counts only visible ALWAYS_ASK fields", () => {
    const fields = [makeField("a"), makeField("b"), makeField("c")];
    const resolved = Object.fromEntries(
      fields.map((f) => [keyFor(f), makeResolved(FieldPolicy.ALWAYS_ASK)]),
    );

    expect(countVisible(fields, resolved, {})).toBe(3);
  });

  it("excludes NEVER_ASK and unmet-showIf fields", () => {
    const fieldA = makeField("a");
    const fieldB = makeField("b"); // NEVER_ASK
    const fieldC = makeField("c", { showIf: { field: "a", value: "yes" } });
    const fields = [fieldA, fieldB, fieldC];
    const resolved: Record<string, ResolvedFieldConfig> = {
      [keyFor(fieldA)]: makeResolved(FieldPolicy.ALWAYS_ASK),
      [keyFor(fieldB)]: makeResolved(FieldPolicy.NEVER_ASK, "baked-in"),
      [keyFor(fieldC)]: makeResolved(FieldPolicy.ALWAYS_ASK),
    };

    // a="no" → c hidden, b always hidden → total=1
    expect(countVisible(fields, resolved, { a: "no" })).toBe(1);
    // a="yes" → c visible, b still hidden → total=2
    expect(countVisible(fields, resolved, { a: "yes" })).toBe(2);
  });

  it("skips fields with no resolved config", () => {
    const fieldA = makeField("a");
    const fieldB = makeField("b");
    const fields = [fieldA, fieldB];
    const resolved: Record<string, ResolvedFieldConfig> = {
      [keyFor(fieldA)]: makeResolved(FieldPolicy.ALWAYS_ASK),
      // b intentionally missing
    };

    expect(countVisible(fields, resolved, {})).toBe(1);
  });
});
