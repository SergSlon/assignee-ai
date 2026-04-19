/**
 * Unit tests for back-handler (Story 56-it2-03c).
 *
 * Covers:
 *   - noop when history is empty (BACK from the very first field).
 *   - jump when history has one entry (single-step back).
 *   - visibleIndex clamp to zero (never negative).
 *   - BFS-clean of transitive showIf dependents (A→B→C chain).
 *   - cleanDependents: root + dependent cleanup in isolation.
 */

import { describe, it, expect } from "vitest";
import { handleBackSentinel, cleanDependents } from "./back-handler.js";
import type { ResourceField } from "@/index.js";

function makeField(
  name: string,
  showIf?: { field: string; value: unknown },
): ResourceField {
  return {
    name,
    question: {
      type: "string",
      label: `Enter ${name}`,
      ...(showIf ? { showIf } : {}),
    },
  };
}

describe("handleBackSentinel", () => {
  it("returns noop when history is empty", () => {
    const fieldA = makeField("a");
    const fields = [fieldA];
    const elicitedOptions: Record<string, unknown> = { a: "tentative" };
    const history: number[] = [];

    const result = handleBackSentinel(
      fieldA,
      fields,
      elicitedOptions,
      history,
      0,
    );

    expect(result).toEqual({ kind: "noop" });
    // State untouched for noop — caller re-prompts current slot.
    expect(elicitedOptions["a"]).toBe("tentative");
    expect(history).toEqual([]);
  });

  it("pops history, deletes prior + current, and returns jump", () => {
    const fieldA = makeField("a");
    const fieldB = makeField("b");
    const fields = [fieldA, fieldB];
    const elicitedOptions: Record<string, unknown> = {
      a: "first",
      b: "second",
    };
    const history: number[] = [0]; // prior slot was index 0 (fieldA)

    const result = handleBackSentinel(
      fieldB,
      fields,
      elicitedOptions,
      history,
      1,
    );

    expect(result).toEqual({ kind: "jump", i: 0, visibleIndex: 0 });
    // Both prior (a) and current (b) are cleared — user re-picks A.
    expect(elicitedOptions["a"]).toBeUndefined();
    expect(elicitedOptions["b"]).toBeUndefined();
    expect(history).toEqual([]);
  });

  it("clamps visibleIndex to zero when already at zero", () => {
    const fieldA = makeField("a");
    const fieldB = makeField("b");
    const fields = [fieldA, fieldB];
    const elicitedOptions: Record<string, unknown> = { a: "first" };
    const history: number[] = [0];

    const result = handleBackSentinel(
      fieldB,
      fields,
      elicitedOptions,
      history,
      0,
    );

    expect(result).toEqual({ kind: "jump", i: 0, visibleIndex: 0 });
  });

  it("BFS-cleans showIf dependents whose chain walks through surviving keys", () => {
    // A → B (showIf A), D (showIf A) where D is an untouched sibling
    // still in elicitedOptions when BFS runs. BACK from B pops prior (A),
    // deletes A + B, then BFS from "a" finds D (showIf.field === "a",
    // "d" in elicitedOptions) and clears it.
    const fieldA = makeField("a");
    const fieldB = makeField("b", { field: "a", value: "yes" });
    const fieldD = makeField("d", { field: "a", value: "yes" });
    const fields = [fieldA, fieldB, fieldD];
    const elicitedOptions: Record<string, unknown> = {
      a: "yes",
      b: "ok",
      d: "dVal",
    };
    const history: number[] = [0]; // prior slot was A (index 0)

    const result = handleBackSentinel(
      fieldB,
      fields,
      elicitedOptions,
      history,
      1,
    );

    expect(result).toEqual({ kind: "jump", i: 0, visibleIndex: 0 });
    // A was deleted (user re-picks it), B was deleted (current).
    expect(elicitedOptions["a"]).toBeUndefined();
    expect(elicitedOptions["b"]).toBeUndefined();
    // D's showIf parent is "a" (the BFS root), so D is transitively cleaned.
    expect(elicitedOptions["d"]).toBeUndefined();
  });
});

describe("cleanDependents", () => {
  it("cleans immediate showIf children of the root", () => {
    const fieldA = makeField("a");
    const fieldB = makeField("b", { field: "a", value: "yes" });
    const fieldC = makeField("c"); // unrelated
    const fields = [fieldA, fieldB, fieldC];
    const elicitedOptions: Record<string, unknown> = {
      a: "yes",
      b: "ok",
      c: "keep-me",
    };

    cleanDependents("a", fields, elicitedOptions);

    expect(elicitedOptions["b"]).toBeUndefined();
    expect(elicitedOptions["c"]).toBe("keep-me");
    // Root itself is NOT cleaned by cleanDependents (caller deletes it).
    expect(elicitedOptions["a"]).toBe("yes");
  });

  it("BFS-cleans transitive dependents (A→B→C chain)", () => {
    const fieldA = makeField("a");
    const fieldB = makeField("b", { field: "a", value: "yes" });
    const fieldC = makeField("c", { field: "b", value: "ok" });
    const fields = [fieldA, fieldB, fieldC];
    const elicitedOptions: Record<string, unknown> = {
      a: "yes",
      b: "ok",
      c: "val",
    };

    cleanDependents("a", fields, elicitedOptions);

    expect(elicitedOptions["b"]).toBeUndefined();
    expect(elicitedOptions["c"]).toBeUndefined();
    expect(elicitedOptions["a"]).toBe("yes");
  });

  it("no-ops when no dependents reference the root", () => {
    const fieldA = makeField("a");
    const fieldB = makeField("b");
    const fields = [fieldA, fieldB];
    const elicitedOptions: Record<string, unknown> = { a: "yes", b: "ok" };

    cleanDependents("a", fields, elicitedOptions);

    expect(elicitedOptions).toEqual({ a: "yes", b: "ok" });
  });
});
