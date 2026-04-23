/**
 * Unit coverage for the `nested_array_predicate` check_type introduced
 * in Epic 98 W4.B1 — the architectural decision documented in bp-audit
 * §6.1 to stop marking real-world rules `awareness` just because they
 * need a JSONPath-like predicate.
 *
 * Test surface:
 *   - Grammar parser: valid shapes, invalid shapes, regex-compile
 *     failures, flag handling.
 *   - Predicate evaluator: firing/no-fire/malformed-input cases using
 *     the canonical BP-ECS-004 secret-in-env expression.
 *   - Non-array fieldValue passes silently (missing outer array).
 *   - Multi-container shape (BP-ECS-004 B-var-3): predicate must scan
 *     every outer element, not just index 0.
 */

import { describe, it, expect } from "vitest";
import {
  nestedArrayPredicatePasses,
  parseNestedArrayPredicate,
} from "../predicates/nested-array-predicate.js";

const BP_ECS_004_EXPR =
  "Environment[?(@.Name=~/^(password|secret|api[_-]?key|token|connection[_-]?string)$/i)] does not exist";

describe("parseNestedArrayPredicate — grammar", () => {
  it("accepts the canonical BP-ECS-004 expression", () => {
    const parsed = parseNestedArrayPredicate(BP_ECS_004_EXPR);
    expect(parsed).toBeDefined();
    expect(parsed?.innerArrayField).toBe("Environment");
    expect(parsed?.propName).toBe("Name");
    expect(parsed?.pattern.flags).toContain("i");
  });

  it("accepts a flag-less predicate", () => {
    const parsed = parseNestedArrayPredicate(
      "Tags[?(@.Key=~/^Env$/)] does not exist",
    );
    expect(parsed).toBeDefined();
    expect(parsed?.pattern.flags).toBe("");
  });

  it("accepts multi-flag regexes (im)", () => {
    const parsed = parseNestedArrayPredicate(
      "Rules[?(@.Name=~/^danger/im)] does not exist",
    );
    expect(parsed).toBeDefined();
    expect(parsed?.pattern.flags.split("").sort().join("")).toBe("im");
  });

  it("rejects missing 'does not exist' terminator", () => {
    const parsed = parseNestedArrayPredicate(
      "Environment[?(@.Name=~/^secret$/)]",
    );
    expect(parsed).toBeUndefined();
  });

  it("rejects malformed filter expression (missing @)", () => {
    const parsed = parseNestedArrayPredicate(
      "Environment[?(Name=~/^secret$/)] does not exist",
    );
    expect(parsed).toBeUndefined();
  });

  it("rejects expressions whose regex body fails to compile", () => {
    // Unbalanced `(` inside the regex body.
    const parsed = parseNestedArrayPredicate(
      "Environment[?(@.Name=~/^(unclosed/)] does not exist",
    );
    expect(parsed).toBeUndefined();
  });

  it("rejects non-string input", () => {
    expect(parseNestedArrayPredicate(42 as unknown as string)).toBeUndefined();
    expect(
      parseNestedArrayPredicate(null as unknown as string),
    ).toBeUndefined();
    expect(
      parseNestedArrayPredicate(undefined as unknown as string),
    ).toBeUndefined();
  });

  it("rejects invalid flag characters (rejects 'x' which is not a JS flag)", () => {
    const parsed = parseNestedArrayPredicate(
      "Environment[?(@.Name=~/^secret$/x)] does not exist",
    );
    expect(parsed).toBeUndefined();
  });
});

describe("nestedArrayPredicatePasses — BP-ECS-004 canonical expression", () => {
  it("PASSES on an empty outer array (no containers)", () => {
    expect(nestedArrayPredicatePasses([], BP_ECS_004_EXPR)).toBe(true);
  });

  it("PASSES when every container has only safe env vars (no-fire baseline)", () => {
    const container = [
      {
        Name: "app",
        Environment: [
          { Name: "LOG_LEVEL", Value: "debug" },
          { Name: "PORT", Value: "8080" },
        ],
      },
    ];
    expect(nestedArrayPredicatePasses(container, BP_ECS_004_EXPR)).toBe(true);
  });

  it("FAILS when a container has a PASSWORD env var (canonical secret)", () => {
    const container = [
      {
        Name: "app",
        Environment: [{ Name: "PASSWORD", Value: "hunter2" }],
      },
    ];
    expect(nestedArrayPredicatePasses(container, BP_ECS_004_EXPR)).toBe(false);
  });

  it("FAILS on lowercase 'password' (i-flag case-insensitive match)", () => {
    const container = [
      {
        Name: "app",
        Environment: [{ Name: "password", Value: "hunter2" }],
      },
    ];
    expect(nestedArrayPredicatePasses(container, BP_ECS_004_EXPR)).toBe(false);
  });

  it.each([
    ["SECRET", "db-secret"],
    ["API_KEY", "sk-abc123"],
    ["API-KEY", "sk-abc123"],
    ["APIKEY", "sk-abc123"],
    ["TOKEN", "ghp_xxxxxxxx"],
    ["CONNECTION_STRING", "postgres://user:pass@host/db"],
    ["CONNECTION-STRING", "postgres://..."],
    ["CONNECTIONSTRING", "postgres://..."],
  ])("FAILS on secret-family env name %s", (name, value) => {
    const container = [
      { Name: "app", Environment: [{ Name: name, Value: value }] },
    ];
    expect(nestedArrayPredicatePasses(container, BP_ECS_004_EXPR)).toBe(false);
  });

  it("PASSES on near-miss env names that contain but do not equal the secret tokens", () => {
    // The regex is anchored `^...$` so SECRET_ARN, TOKEN_ENDPOINT,
    // PASSWORDLESS_MODE do NOT match. This guards against over-broad
    // false positives — the rule is opinionated about plaintext
    // secrets, not about any env name containing the substring.
    const container = [
      {
        Name: "app",
        Environment: [
          { Name: "SECRET_ARN", Value: "arn:aws:secretsmanager:..." },
          { Name: "TOKEN_ENDPOINT", Value: "https://..." },
          { Name: "PASSWORDLESS_MODE", Value: "true" },
        ],
      },
    ];
    expect(nestedArrayPredicatePasses(container, BP_ECS_004_EXPR)).toBe(true);
  });

  it("FAILS when ANY of multiple containers has a secret env (multi-container scan)", () => {
    // BP-ECS-004 probe variation 3: two containers, one clean, one
    // with SECRET_KEY. The predicate must scan EVERY outer element —
    // a naïve `ContainerDefinitions[0]` index would silently pass.
    // Note: the regex does NOT match SECRET_KEY (suffix), so this
    // fixture uses the canonical SECRET token to trigger.
    const container = [
      {
        Name: "clean",
        Environment: [{ Name: "LOG_LEVEL", Value: "info" }],
      },
      {
        Name: "dirty",
        Environment: [{ Name: "SECRET", Value: "leaked" }],
      },
    ];
    expect(nestedArrayPredicatePasses(container, BP_ECS_004_EXPR)).toBe(false);
  });

  it("PASSES when containers have no Environment array (undefined inner)", () => {
    const container = [{ Name: "app" }];
    expect(nestedArrayPredicatePasses(container, BP_ECS_004_EXPR)).toBe(true);
  });

  it("PASSES when Environment is an empty array", () => {
    const container = [{ Name: "app", Environment: [] }];
    expect(nestedArrayPredicatePasses(container, BP_ECS_004_EXPR)).toBe(true);
  });
});

describe("nestedArrayPredicatePasses — defensive cases", () => {
  it("PASSES silently on a malformed expected_value (YAML typo guard)", () => {
    expect(
      nestedArrayPredicatePasses(
        [{ Environment: [{ Name: "PASSWORD" }] }],
        "not-valid-grammar",
      ),
    ).toBe(true);
  });

  it("PASSES when fieldValue is not an array (missing outer property)", () => {
    expect(nestedArrayPredicatePasses(undefined, BP_ECS_004_EXPR)).toBe(true);
    expect(nestedArrayPredicatePasses(null, BP_ECS_004_EXPR)).toBe(true);
    expect(nestedArrayPredicatePasses({}, BP_ECS_004_EXPR)).toBe(true);
    expect(nestedArrayPredicatePasses("junk", BP_ECS_004_EXPR)).toBe(true);
  });

  it("skips non-object outer-array elements", () => {
    // A string in the outer array must not crash the predicate — it
    // cannot carry an Environment sub-array, so it contributes nothing.
    // The predicate should still examine any well-shaped neighbours.
    const mixed = [
      "junk" as unknown as Record<string, unknown>,
      { Environment: [{ Name: "PASSWORD", Value: "hunter2" }] },
    ];
    expect(nestedArrayPredicatePasses(mixed, BP_ECS_004_EXPR)).toBe(false);
  });

  it("skips non-object inner-array elements", () => {
    const container = [
      {
        Environment: ["junk", 42, null, { Name: "PASSWORD", Value: "hunter2" }],
      },
    ];
    expect(nestedArrayPredicatePasses(container, BP_ECS_004_EXPR)).toBe(false);
  });

  it("skips inner elements whose <prop> is not a string", () => {
    const container = [
      {
        Environment: [
          { Name: 123 }, // non-string Name — skipped
          { Name: null }, // null Name — skipped
          { Name: "LOG_LEVEL", Value: "info" }, // safe
        ],
      },
    ];
    expect(nestedArrayPredicatePasses(container, BP_ECS_004_EXPR)).toBe(true);
  });

  it("PASSES when the inner array field is absent on every outer element", () => {
    const container = [{ Name: "a" }, { Name: "b" }, { Name: "c" }];
    expect(nestedArrayPredicatePasses(container, BP_ECS_004_EXPR)).toBe(true);
  });

  it("PASSES when the inner array value is not an array (wrong shape)", () => {
    const container = [{ Environment: "not-an-array" }];
    expect(nestedArrayPredicatePasses(container, BP_ECS_004_EXPR)).toBe(true);
  });
});
