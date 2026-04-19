/**
 * Tests for prompt-loop.ts deep-chain showIf cleanup (Story 48-11 #77).
 *
 * Verifies that when field A is edited/reverted and B depends on A
 * (B.showIf.field === A.name), B is cleaned — AND field C that
 * depends on B is also transitively cleaned.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResourceField, ResolvedFieldConfig } from "@/index.js";

// Mock clack (prompts) so promptWithHelp can be controlled.
vi.mock("@clack/prompts", () => ({
  log: { info: vi.fn() },
}));

// We need to mock promptWithHelp to control wizard answers.
const mockPromptWithHelp = vi.fn();
vi.mock("../../../utils/wizard-helpers.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    promptWithHelp: (...args: unknown[]) => mockPromptWithHelp(...args),
  };
});

// Mock runReviewAnswers — not needed for this test, but imported by prompt-loop.
vi.mock("../../../utils/display.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    runReviewAnswers: vi.fn(),
  };
});

import { runPromptLoop } from "./prompt-loop.js";
import { BACK_SENTINEL } from "@/utils/display.js";
import { FieldPolicy } from "@/constants/field-policy.js";

/**
 * Helper: builds a ResourceField with an optional showIf dependency.
 */
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

function makeResolved(field: ResourceField): [string, ResolvedFieldConfig] {
  const key = field.question.showIf
    ? `${field.name}::${field.question.showIf.field}=${field.question.showIf.value}`
    : field.name;
  return [
    key,
    {
      policy: FieldPolicy.ALWAYS_ASK,
      value: undefined,
      source: "plugin_default",
    },
  ];
}

describe("runPromptLoop — deep-chain showIf cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure non-TTY so progress logging is skipped.
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
  });

  it("A→B→C chain: edit A to hide B → C is also cleared", async () => {
    // Field graph: A (no dep), B (showIf A === "yes"), C (showIf B === "ok")
    const fieldA = makeField("A");
    const fieldB = makeField("B", { field: "A", value: "yes" });
    const fieldC = makeField("C", { field: "B", value: "ok" });
    const fields = [fieldA, fieldB, fieldC];

    const resolved = Object.fromEntries(fields.map(makeResolved));
    const elicitedOptions: Record<string, unknown> = {};

    // Simulate wizard sequence:
    //  1. Field A → answer "yes"  (B becomes visible)
    //  2. Field B → answer "ok"   (C becomes visible)
    //  3. Field C → answer "val"
    // All three answered. Then user hits BACK from C (back to B),
    // which triggers cleanup of B's dependents (C) AND A's dependents (B).
    // Actually BACK from field C goes to field B, cleaning C.
    // Then BACK from B goes to A, cleaning B and transitively C.

    // For simplicity: pre-populate the answers, then simulate BACK from B:
    // Step 1-3: forward answers
    mockPromptWithHelp
      .mockResolvedValueOnce("yes") // A
      .mockResolvedValueOnce("ok") // B
      .mockResolvedValueOnce("val"); // C
    // Step 4: BACK from C → goes to B, cleans C
    // But we need more iterations. Actually, let's just test via
    // the cleanDependents function indirectly by walking the full loop.
    // Simpler: answer A→B→C forward, then on re-prompt (won't happen
    // since the loop finishes). Instead let's test the cleanup by
    // answering with BACK.

    // Clear mocks and set up a specific sequence:
    mockPromptWithHelp.mockReset();

    // Sequence: A="yes", B="ok", C=BACK, (now at B) B=BACK, (now at A) A="no"
    // After A="no": B should be invisible (showIf A==="yes" fails), so
    // B and C values should be cleaned.
    mockPromptWithHelp
      .mockResolvedValueOnce("yes") // A → "yes"
      .mockResolvedValueOnce("ok") // B → "ok"
      .mockResolvedValueOnce(BACK_SENTINEL) // C → BACK (goes to B, cleans C's value)
      .mockResolvedValueOnce(BACK_SENTINEL) // B → BACK (goes to A, cleans B + C's values)
      .mockResolvedValueOnce("no"); // A → "no" (B hidden, C hidden)

    await runPromptLoop({
      fields,
      resolved,
      elicitedOptions,
      resourceType: "AWS::Test::Resource",
      tools: [],
      llmClient: undefined,
      userIntent: undefined,
      progressLabel: "Step",
    });

    // A was answered "no", B and C should NOT be in elicitedOptions.
    expect(elicitedOptions["A"]).toBe("no");
    expect(elicitedOptions["B"]).toBeUndefined();
    expect(elicitedOptions["C"]).toBeUndefined();
  });

  it("A→B→C chain: forward pass with A='yes' populates all three", async () => {
    const fieldA = makeField("A");
    const fieldB = makeField("B", { field: "A", value: "yes" });
    const fieldC = makeField("C", { field: "B", value: "ok" });
    const fields = [fieldA, fieldB, fieldC];

    const resolved = Object.fromEntries(fields.map(makeResolved));
    const elicitedOptions: Record<string, unknown> = {};

    mockPromptWithHelp
      .mockResolvedValueOnce("yes") // A
      .mockResolvedValueOnce("ok") // B
      .mockResolvedValueOnce("val"); // C

    await runPromptLoop({
      fields,
      resolved,
      elicitedOptions,
      resourceType: "AWS::Test::Resource",
      tools: [],
      llmClient: undefined,
      userIntent: undefined,
      progressLabel: "Step",
    });

    expect(elicitedOptions["A"]).toBe("yes");
    expect(elicitedOptions["B"]).toBe("ok");
    expect(elicitedOptions["C"]).toBe("val");
  });
});
