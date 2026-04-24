import { describe, it, expect } from "vitest";
import { ErrorCode } from "./errors.js";

/**
 * Drift-guard: ErrorCode enum wire-format stability.
 *
 * Epic 99 Wave 2 Lane 2d (Q-013): `INVALID_DESIRED_STATE` was previously
 * emitted as a raw string literal. Now it lives in the ErrorCode enum. This
 * test locks the enum member to the exact string that existing E2E tests,
 * CI scripts, and the CLI `--output json` envelope all depend on. If the
 * wire value ever drifts (rename, typo), this test catches it before the
 * breaking change reaches consumers.
 *
 * Pattern follows `placeholder-accounts.test.ts` in the same directory.
 */
describe("ErrorCode wire-format drift-guard", () => {
  it("INVALID_DESIRED_STATE enum member equals its wire string", () => {
    expect(ErrorCode.INVALID_DESIRED_STATE).toBe("INVALID_DESIRED_STATE");
  });

  it("APPLY_FAILED enum member equals its wire string", () => {
    expect(ErrorCode.APPLY_FAILED).toBe("APPLY_FAILED");
  });

  it("BP_BLOCKED enum member equals its wire string", () => {
    expect(ErrorCode.BP_BLOCKED).toBe("BP_BLOCKED");
  });

  it("INVALID_NAME enum member equals its wire string", () => {
    expect(ErrorCode.INVALID_NAME).toBe("INVALID_NAME");
  });
});
