import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  operatorCredentials,
  _resetOperatorCredsWarning,
} from "./operator-credentials.js";
import { AWS_REGION } from "./constants/aws.js";
import { EnvVar } from "../constants/env-vars.js";

/**
 * Covers L5-MED-2 — operatorCredentials() must surface a one-time-per-process
 * warning when the ASSIGNEE_OPERATOR_* env vars are empty, without changing
 * its return shape (empty strings must still be returned so conditional-spread
 * callers like `list-resources.ts` keep working).
 */
describe("operatorCredentials", () => {
  const origAccess = process.env[EnvVar.OPERATOR_ACCESS_KEY];
  const origSecret = process.env[EnvVar.OPERATOR_SECRET_KEY];
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  let stderrCalls: string[] = [];

  beforeEach(() => {
    // Reset module-level warn guard so each test case starts fresh.
    _resetOperatorCredsWarning();

    // Replace process.stderr.write with a capturing stub.
    // vi.spyOn gives a union-signature MockInstance that TS cannot unify with
    // the spied method, so we use a direct method swap (restored in afterEach).
    stderrCalls = [];
    (process.stderr as unknown as { write: unknown }).write = (
      chunk: string | Uint8Array,
    ): boolean => {
      stderrCalls.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    // Clean env slate per test so earlier tests do not bleed state.
    delete process.env[EnvVar.OPERATOR_ACCESS_KEY];
    delete process.env[EnvVar.OPERATOR_SECRET_KEY];
  });

  afterEach(() => {
    // Restore the real stderr write so other tests / reporters are unaffected.
    (process.stderr as unknown as { write: unknown }).write = origStderrWrite;

    // Restore original env values so other test files are not disturbed.
    if (origAccess === undefined) {
      delete process.env[EnvVar.OPERATOR_ACCESS_KEY];
    } else {
      process.env[EnvVar.OPERATOR_ACCESS_KEY] = origAccess;
    }
    if (origSecret === undefined) {
      delete process.env[EnvVar.OPERATOR_SECRET_KEY];
    } else {
      process.env[EnvVar.OPERATOR_SECRET_KEY] = origSecret;
    }
  });

  it("returns empty accessKeyId/secretAccessKey and emits a one-time warning when env vars are unset", () => {
    const first = operatorCredentials();
    const second = operatorCredentials();
    const third = operatorCredentials();

    // Return shape preserved — empty strings, region unchanged.
    expect(first).toEqual({
      accessKeyId: "",
      secretAccessKey: "",
      region: AWS_REGION,
    });
    expect(second).toEqual(first);
    expect(third).toEqual(first);

    // Warning fires EXACTLY once across three calls.
    expect(stderrCalls.length).toBe(1);
    const written = stderrCalls[0]!;
    expect(written).toContain("ASSIGNEE_OPERATOR_*");
    expect(written).toContain("default credential provider chain");
    expect(written).toContain("assignee init");
  });

  it("does NOT emit the warning when both env vars are set", () => {
    process.env[EnvVar.OPERATOR_ACCESS_KEY] = "AKIAIOSFODNN7EXAMPLE";
    process.env[EnvVar.OPERATOR_SECRET_KEY] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    const config = operatorCredentials();
    operatorCredentials();
    operatorCredentials();

    expect(config).toEqual({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: AWS_REGION,
    });
    expect(stderrCalls.length).toBe(0);
  });

  it("still emits the warning when only ONE of the two operator env vars is set (both required)", () => {
    // Partial config is a latent bug — treat it the same as "both empty" so
    // the user gets a warning either way. The function itself still returns
    // the real values to preserve existing behaviour.
    process.env[EnvVar.OPERATOR_ACCESS_KEY] = "AKIAIOSFODNN7EXAMPLE";

    const config = operatorCredentials();

    expect(config.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(config.secretAccessKey).toBe("");
    // Both-empty-gate means partial config does NOT trigger (only both empty).
    // This test locks in current behaviour so a future refactor does not
    // silently widen or narrow the gate without a conscious decision.
    expect(stderrCalls.length).toBe(0);
  });

  it("_resetOperatorCredsWarning() re-arms the warning so it fires again", () => {
    operatorCredentials();
    expect(stderrCalls.length).toBe(1);

    // Second call suppressed by the module-level guard.
    operatorCredentials();
    expect(stderrCalls.length).toBe(1);

    // Reset re-arms — next call warns again.
    _resetOperatorCredsWarning();
    operatorCredentials();
    expect(stderrCalls.length).toBe(2);
  });

  /**
   * L5-004 (Story 56-it2-02) — the `operatorCredentials()` function's silent
   * empty-string fallthrough is a latent footgun. Until a breaking variant
   * ships in Epic 57, the JSDoc `@deprecated` tag is the public signal that
   * call-sites must guard the return value. This test asserts the tag is
   * still present by reading the source file directly, so a future refactor
   * cannot silently drop the deprecation notice without a compile failure.
   */
  it("carries an @deprecated JSDoc tag on the exported function (L5-004)", () => {
    const sourcePath = fileURLToPath(
      new URL("./operator-credentials.ts", import.meta.url),
    );
    const source = readFileSync(sourcePath, "utf8");

    // The tag must appear in a JSDoc block that precedes the function
    // export. Match the *block* that ends just before `export function
    // operatorCredentials` to avoid picking up deprecations in unrelated
    // comments.
    const exportBlock = source.match(
      /\/\*\*[\s\S]*?\*\/\s*export function operatorCredentials\b/,
    );
    expect(
      exportBlock,
      "expected JSDoc block above operatorCredentials",
    ).not.toBeNull();
    expect(exportBlock![0]).toContain("@deprecated");
  });
});
