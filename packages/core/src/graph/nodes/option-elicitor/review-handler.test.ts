/**
 * Unit tests for review-handler (Story 56-it2-03c).
 *
 * Covers the Story 48.7 mid-wizard review-answers flow:
 *   - cancel path → reprompt-current, no state mutation.
 *   - edit path with new value → commit new value, BFS-clean dependents,
 *     truncate history, jump to editIdx + 1.
 *   - edit path cancelled via BACK → restore prior answer, still jump past
 *     editIdx.
 *   - edit path on field with missing resolved config → defensive
 *     reprompt-current.
 *   - edit path on field with showIf-dependent downstream → dependent
 *     cleared after edit.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResourceField, ResolvedFieldConfig } from "../../../index.js";
import { FieldPolicy } from "../../../constants/field-policy.js";

// Mock clack so runReviewAnswers / promptWithHelp internals are harmless.
vi.mock("@clack/prompts", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Control runReviewAnswers' return value directly.
const mockRunReviewAnswers = vi.fn();
vi.mock("../../../utils/display.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    runReviewAnswers: (...args: unknown[]) => mockRunReviewAnswers(...args),
  };
});

// Control promptWithHelp return value (the re-prompt after picking "edit").
const mockPromptWithHelp = vi.fn();
vi.mock("../../../utils/wizard-helpers.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    promptWithHelp: (...args: unknown[]) => mockPromptWithHelp(...args),
  };
});

const { handleReviewSentinel } = await import("./review-handler.js");
const { BACK_SENTINEL } = await import("../../../utils/display.js");

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

function keyFor(field: ResourceField): string {
  const cond = field.question.showIf;
  if (!cond) return field.name;
  const suffix = cond.pattern ?? String(cond.value);
  return `${field.name}::${cond.field}=${suffix}`;
}

function makeResolved(
  policy: ResolvedFieldConfig["policy"] = FieldPolicy.ALWAYS_ASK,
  value: unknown = undefined,
): ResolvedFieldConfig {
  return { policy, value, source: "plugin_default" };
}

describe("handleReviewSentinel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns reprompt-current when user cancels the review UI", async () => {
    mockRunReviewAnswers.mockResolvedValueOnce({ action: "cancel" });
    const fieldA = makeField("a");
    const fields = [fieldA];
    const resolved = { [keyFor(fieldA)]: makeResolved() };
    const elicitedOptions: Record<string, unknown> = { a: "original" };
    const history: number[] = [];

    const result = await handleReviewSentinel({
      fields,
      resolved,
      elicitedOptions,
      resourceType: "AWS::Test::Resource",
      tools: [],
      llmClient: undefined,
      userIntent: undefined,
      history,
    });

    expect(result).toEqual({ kind: "reprompt-current" });
    expect(elicitedOptions["a"]).toBe("original");
    expect(mockPromptWithHelp).not.toHaveBeenCalled();
  });

  it("commits new value, truncates history, and jumps past editIdx", async () => {
    const fieldA = makeField("a");
    const fieldB = makeField("b");
    const fieldC = makeField("c");
    const fields = [fieldA, fieldB, fieldC];
    const resolved = {
      [keyFor(fieldA)]: makeResolved(),
      [keyFor(fieldB)]: makeResolved(),
      [keyFor(fieldC)]: makeResolved(),
    };
    const elicitedOptions: Record<string, unknown> = {
      a: "aVal",
      b: "bVal",
      c: "cVal",
    };
    // Walk had visited all three slots → history carries 0,1,2.
    const history: number[] = [0, 1, 2];

    mockRunReviewAnswers.mockResolvedValueOnce({
      action: "edit",
      fieldIndex: 1,
    });
    mockPromptWithHelp.mockResolvedValueOnce("bUpdated");

    const result = await handleReviewSentinel({
      fields,
      resolved,
      elicitedOptions,
      resourceType: "AWS::Test::Resource",
      tools: [],
      llmClient: undefined,
      userIntent: undefined,
      history,
    });

    expect(result).toEqual({
      kind: "jump",
      i: 2,
      visibleIndex: 2, // visible fields at indices 0..1 = 2 (a + b)
      total: 3,
    });
    expect(elicitedOptions["b"]).toBe("bUpdated");
    expect(elicitedOptions["a"]).toBe("aVal");
    // History is truncated to slots strictly before editIdx (=1).
    expect(history).toEqual([0]);
  });

  it("restores prior answer when user cancels the edit via BACK", async () => {
    const fieldA = makeField("a");
    const fields = [fieldA];
    const resolved = { [keyFor(fieldA)]: makeResolved() };
    const elicitedOptions: Record<string, unknown> = { a: "original" };
    const history: number[] = [0];

    mockRunReviewAnswers.mockResolvedValueOnce({
      action: "edit",
      fieldIndex: 0,
    });
    // User hits BACK on the re-prompt → cancel edit.
    mockPromptWithHelp.mockResolvedValueOnce(BACK_SENTINEL);

    const result = await handleReviewSentinel({
      fields,
      resolved,
      elicitedOptions,
      resourceType: "AWS::Test::Resource",
      tools: [],
      llmClient: undefined,
      userIntent: undefined,
      history,
    });

    expect(result).toEqual({ kind: "jump", i: 1, visibleIndex: 1, total: 1 });
    // Prior answer restored — rest of tier unchanged.
    expect(elicitedOptions["a"]).toBe("original");
    // History truncated to slots before editIdx=0 → empty.
    expect(history).toEqual([]);
  });

  it("returns reprompt-current when picked field has no resolved config", async () => {
    const fieldA = makeField("a");
    const fields = [fieldA];
    // Intentionally empty resolved — simulates race/edge where editing a
    // stale field index would have no config.
    const resolved: Record<string, ResolvedFieldConfig> = {};
    const elicitedOptions: Record<string, unknown> = { a: "original" };
    const history: number[] = [];

    mockRunReviewAnswers.mockResolvedValueOnce({
      action: "edit",
      fieldIndex: 0,
    });

    const result = await handleReviewSentinel({
      fields,
      resolved,
      elicitedOptions,
      resourceType: "AWS::Test::Resource",
      tools: [],
      llmClient: undefined,
      userIntent: undefined,
      history,
    });

    expect(result).toEqual({ kind: "reprompt-current" });
    expect(elicitedOptions["a"]).toBe("original");
    expect(mockPromptWithHelp).not.toHaveBeenCalled();
  });

  it("BFS-cleans downstream showIf dependents after edit", async () => {
    // A → B (showIf A==="yes"). Editing A to "no" should clear B.
    const fieldA = makeField("a");
    const fieldB = makeField("b", { field: "a", value: "yes" });
    const fields = [fieldA, fieldB];
    const resolved = {
      [keyFor(fieldA)]: makeResolved(),
      [keyFor(fieldB)]: makeResolved(),
    };
    const elicitedOptions: Record<string, unknown> = { a: "yes", b: "ok" };
    const history: number[] = [0, 1];

    mockRunReviewAnswers.mockResolvedValueOnce({
      action: "edit",
      fieldIndex: 0,
    });
    mockPromptWithHelp.mockResolvedValueOnce("no");

    const result = await handleReviewSentinel({
      fields,
      resolved,
      elicitedOptions,
      resourceType: "AWS::Test::Resource",
      tools: [],
      llmClient: undefined,
      userIntent: undefined,
      history,
    });

    expect(elicitedOptions["a"]).toBe("no");
    // B was cleaned by BFS before re-prompt (its showIf parent changed).
    expect(elicitedOptions["b"]).toBeUndefined();
    // Jump past editIdx=0 → i=1, and total recomputes to 1 (B now hidden).
    expect(result).toEqual({ kind: "jump", i: 1, visibleIndex: 1, total: 1 });
  });
});
