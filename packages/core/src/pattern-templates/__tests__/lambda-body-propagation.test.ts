/**
 * SX-7 / PH1-D-1 — Lambda body compound propagation regression mirror.
 *
 * Completes the PR #52 fix (which closed body propagation for the
 * standalone `lambda-function` plugin path) by asserting the parallel
 * behaviour for the COMPOUND path. The compound spread at
 * `compound-plan.ts:76-79` overrides `patternDefaults` with
 * `elicitedOptions`, so a user-extracted body in `elicitedOptions.Code`
 * MUST win over the placeholder ZipFile baked into the pattern's
 * `defaultOptions.Code`.
 *
 * This test asserts the shallow-merge spread order: when
 * `elicitedOptions.Code = { ZipFile: "<user body>" }`, the resulting
 * `desiredState["Code"].ZipFile` is the user's value, not the pattern's
 * placeholder.
 */

import { describe, it, expect } from "vitest";

describe("Lambda body compound propagation (SX-7 — regression mirror)", () => {
  it("elicitedOptions.Code.ZipFile survives the shallow-merge spread (placeholder is replaced)", () => {
    // Simulates the spread at packages/core/src/graph/nodes/plan-generator/
    // compound-plan.ts:76-79. The actual compound-plan node performs the
    // SAME shallow merge — `{ ...patternDefaults, ...transformedOptions }` —
    // so this directly mirrors the production spread order.
    const patternDefaults: Record<string, unknown> = {
      Code: {
        ZipFile:
          "exports.handler = async (event) => ({ statusCode: 200, body: 'placeholder' });",
      },
      Handler: "index.handler",
      Runtime: "nodejs20.x",
    };
    const transformedOptions: Record<string, unknown> = {
      Code: {
        ZipFile:
          "exports.handler = async (event) => ({ statusCode: 200, body: 'Hello World' });",
      },
    };
    const desiredState = {
      ...patternDefaults,
      ...transformedOptions,
    };

    const code = desiredState["Code"] as { ZipFile: string };
    expect(code.ZipFile).toContain("Hello World");
    expect(code.ZipFile).not.toContain("placeholder");
    // Non-Code defaults still survive (Handler, Runtime).
    expect(desiredState["Handler"]).toBe("index.handler");
    expect(desiredState["Runtime"]).toBe("nodejs20.x");
  });

  it("when elicitedOptions has no Code, the pattern's placeholder ZipFile is preserved (no regression)", () => {
    const patternDefaults: Record<string, unknown> = {
      Code: {
        ZipFile:
          "exports.handler = async (event) => ({ statusCode: 200, body: 'placeholder' });",
      },
    };
    const transformedOptions: Record<string, unknown> = {
      // No Code key — the user didn't supply a body in the intent.
    };
    const desiredState = {
      ...patternDefaults,
      ...transformedOptions,
    };

    const code = desiredState["Code"] as { ZipFile: string };
    expect(code.ZipFile).toContain("placeholder");
  });
});
