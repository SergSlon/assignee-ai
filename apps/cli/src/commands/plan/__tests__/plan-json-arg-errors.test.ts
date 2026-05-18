/**
 * Epic 94 N3 (A-03 / A-09) — unit coverage for `resolvePlanArgs`
 * error codes.
 *
 * Before N3:
 *   - empty intent threw `AssigneeError` with code `MISSING_INTENT`
 *     but NO `.hint` field → plan.ts's R5 envelope fell back to the
 *     generic `Run with --verbose for full stack trace.` hint.
 *   - malformed `--set <token>` threw `AssigneeError` with code
 *     `USAGE_ERROR` (overly broad — indistinguishable from other
 *     usage failures).
 *
 * After N3:
 *   - empty intent → code `MISSING_INTENT`, message preserved, `.hint`
 *     attached (quote-your-intent guidance).
 *   - malformed `--set` → code `BAD_SET_SYNTAX`, message preserved,
 *     `.hint` attached (one-pair-per-flag guidance).
 *
 * These assertions exercise the ARG-PARSER directly (no Commander)
 * so regressions in the throw shape are caught at the shortest
 * possible feedback loop. The end-to-end envelope shape is verified
 * in `src/e2e/e94-plan-json-empty-intent.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { AssigneeError } from "@assignee/core";
import { resolvePlanArgs, type PlanOpts } from "../arg-parser.js";

describe("Epic 94 N3 — resolvePlanArgs error codes", () => {
  it("A-03: empty intent throws AssigneeError(code=MISSING_INTENT) with hint", () => {
    const opts: PlanOpts = {};
    let caught: unknown;
    try {
      resolvePlanArgs(undefined, opts);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AssigneeError);
    const err = caught as AssigneeError & { hint?: string };
    expect(err.code).toBe("MISSING_INTENT");
    expect(err.message).toContain("Missing intent");
    // The example intent from constants must still be present so the
    // user sees a runnable quoted example.
    expect(err.message).toMatch(/assignee infra plan "[^"]+"/);
    // Hint is load-bearing for the R5 envelope's `error.hint` field.
    expect(err.hint).toBeDefined();
    expect(err.hint!.length).toBeGreaterThan(0);
    expect(err.hint).toMatch(/quote/i);
  });

  it("A-03: empty-string intent (falsy) also throws MISSING_INTENT", () => {
    // `plan "" --json` lands here — Commander passes the empty string
    // as the intent positional, which is falsy and must hit the same
    // branch as missing/undefined.
    let caught: unknown;
    try {
      resolvePlanArgs("", {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AssigneeError);
    expect((caught as AssigneeError).code).toBe("MISSING_INTENT");
  });

  it("A-09: malformed --set token throws AssigneeError(code=BAD_SET_SYNTAX) with hint", () => {
    const opts: PlanOpts = { set: ["BAD-SYNTAX"] };
    let caught: unknown;
    try {
      resolvePlanArgs("Create an S3 bucket named my-bucket", opts);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AssigneeError);
    const err = caught as AssigneeError & { hint?: string };
    expect(err.code).toBe("BAD_SET_SYNTAX");
    // Message verbatim from C-17 so existing assertions still match.
    expect(err.message).toContain('Invalid --set token "BAD-SYNTAX"');
    expect(err.message).toContain("Expected key=value");
    // Hint must be attached so the R5 envelope populates `error.hint`.
    expect(err.hint).toBeDefined();
    expect(err.hint!.length).toBeGreaterThan(0);
  });

  it("A-09: malformed --set without `=` at all → BAD_SET_SYNTAX", () => {
    // `--set badsyntax` (no `=`) is a distinct malformed shape from
    // `--set BAD-SYNTAX` (has `-` which isn't legal in the identifier
    // regex). Both must emit the same code.
    let caught: unknown;
    try {
      resolvePlanArgs("Create an S3 bucket named my-bucket", {
        set: ["badsyntax"],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AssigneeError);
    expect((caught as AssigneeError).code).toBe("BAD_SET_SYNTAX");
  });

  it("A-09: --set with empty key (starts with =) → BAD_SET_SYNTAX", () => {
    let caught: unknown;
    try {
      resolvePlanArgs("Create an S3 bucket named my-bucket", {
        set: ["=oops"],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AssigneeError);
    expect((caught as AssigneeError).code).toBe("BAD_SET_SYNTAX");
  });

  it("A-09: legitimate --set key=value and --set key= are accepted", () => {
    // Regression guard — the BAD_SET_SYNTAX branch must NOT trigger
    // for well-formed tokens. Empty value `Tags=` is a legitimate
    // clear-the-field gesture (documented in arg-parser.ts).
    expect(() =>
      resolvePlanArgs("Create an S3 bucket named my-bucket", {
        set: ["size=t3.medium", "Tags="],
      }),
    ).not.toThrow();
  });
});
