/**
 * Tests for renderOptionPrompt (TTY, non-TTY, edge cases, categorySelect).
 *
 * Split from display.test.ts (W19-S1).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ResourceField } from "../resource-plugins/types.js";
import type { ResolvedFieldConfig } from "../config/resource-policy.js";

// ── @clack/prompts mock ───────────────────────────────────────────────────────

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
  multiselect: vi.fn(),
  autocomplete: vi.fn(),
  autocompleteMultiselect: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
  note: vi.fn(),
  log: { info: vi.fn() },
}));

const { confirm, select, text, multiselect, isCancel, note, log } =
  await import("@clack/prompts");

// ── Shared test helpers ───────────────────────────────────────────────────────

function makeField(
  overrides: Partial<ResourceField["question"]> & { name?: string } = {},
): ResourceField {
  const { name = "TestField", ...q } = overrides;
  return {
    name,
    question: {
      type: "string",
      label: "Test label",
      ...q,
    },
  };
}

const resolved: ResolvedFieldConfig = {
  policy: "ask_if_not_set",
  value: undefined,
  source: "plugin_default",
};

// ── renderOptionPrompt — TTY mode ─────────────────────────────────────────────

describe("renderOptionPrompt — TTY mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("calls clack.text for string type", async () => {
    vi.mocked(text).mockResolvedValueOnce("hello");
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({ type: "string" }),
      resolved,
    );
    expect(text).toHaveBeenCalledOnce();
    expect(result).toBe("hello");
  });

  it("calls clack.confirm for boolean type", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(true);
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({ type: "boolean", label: "Enable?" }),
      resolved,
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enable?" }),
    );
    expect(result).toBe(true);
  });

  it("calls clack.select for enum type", async () => {
    vi.mocked(select).mockResolvedValueOnce("opt-a");
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({
        type: "enum",
        options: [{ value: "opt-a", label: "Option A" }],
      }),
      resolved,
    );
    expect(select).toHaveBeenCalledOnce();
    expect(result).toBe("opt-a");
  });

  it("calls clack.multiselect for multi type", async () => {
    vi.mocked(multiselect).mockResolvedValueOnce(["a", "b"]);
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({ type: "multi", options: [{ value: "a", label: "A" }] }),
      resolved,
    );
    expect(multiselect).toHaveBeenCalledOnce();
    expect(result).toEqual(["a", "b"]);
  });

  it("returns undefined for multi type with empty options (no crash)", async () => {
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({ type: "multi", options: [] }),
      resolved,
    );
    expect(multiselect).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("throws UserCancelledError when clack.isCancel returns true", async () => {
    vi.mocked(text).mockResolvedValueOnce(
      Symbol("cancel") as unknown as string,
    );
    vi.mocked(isCancel).mockReturnValueOnce(true);
    const { renderOptionPrompt } = await import("./display.js");
    await expect(
      renderOptionPrompt(makeField({ type: "string" }), {
        ...resolved,
        value: "fallback",
      }),
    ).rejects.toThrow("Operation cancelled by user.");
  });
});

// ── renderOptionPrompt — non-TTY mode ─────────────────────────────────────────

describe("renderOptionPrompt — non-TTY mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("returns resolved.value without prompting", async () => {
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(makeField({ type: "string" }), {
      ...resolved,
      value: "preset",
    });
    expect(text).not.toHaveBeenCalled();
    expect(result).toBe("preset");
  });

  it("returns field initialValue when resolved.value is undefined", async () => {
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({ type: "boolean", initialValue: true }),
      resolved,
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });
});

// ── renderOptionPrompt — edge cases ───────────────────────────────────────────

describe("renderOptionPrompt — edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("boolean field — false (via clack.confirm)", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(false);
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({ type: "boolean", label: "Enable?" }),
      resolved,
    );
    expect(result).toBe(false);
  });

  it("boolean field — true (via clack.confirm)", async () => {
    vi.mocked(confirm).mockResolvedValueOnce(true);
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({ type: "boolean", label: "Enable?" }),
      resolved,
    );
    expect(result).toBe(true);
  });

  it("string field — empty string returns undefined (skipped)", async () => {
    vi.mocked(text).mockResolvedValueOnce("  ");
    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(
      makeField({ type: "string" }),
      resolved,
    );
    expect(result).toBeUndefined();
  });

  it("field with hint — clack.note called before prompt", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    vi.mocked(text).mockResolvedValueOnce("value");
    const { renderOptionPrompt } = await import("./display.js");
    await renderOptionPrompt(
      makeField({ type: "string", hint: "Contextual hint" }),
      resolved,
    );
    expect(vi.mocked(note)).toHaveBeenCalledWith(
      "Contextual hint",
      "TestField",
    );
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });
});

// ── renderOptionPrompt — categorySelect tests (Story 18.12) ──────────────────

describe("renderOptionPrompt — categorySelect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  const categoryField: ResourceField = {
    name: "InstanceType",
    question: {
      type: "categorySelect",
      label: "Instance type",
      initialValue: "t3.micro",
      categories: [
        {
          key: "burstable",
          label: "Burstable (t3/t4g) — $0.008-0.17/hr",
          description: "Variable CPU with burst credits.",
          options: [
            { value: "t3.micro", label: "t3.micro (2 vCPU, 1 GiB)" },
            {
              value: "t3.small",
              label: "t3.small (2 vCPU, 2 GiB)",
              recommended: true,
            },
          ],
        },
        {
          key: "compute",
          label: "Compute Optimized (c5/c6i) — $0.085-0.34/hr",
          description: "High-performance CPUs.",
          options: [
            { value: "c5.large", label: "c5.large (2 vCPU, 4 GiB)" },
            { value: "c5.xlarge", label: "c5.xlarge (4 vCPU, 8 GiB)" },
          ],
        },
      ],
    },
  };

  it("two-step flow: category select then size select returns instance type value", async () => {
    vi.mocked(select)
      .mockResolvedValueOnce("burstable")
      .mockResolvedValueOnce("t3.small");

    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(categoryField, resolved);

    expect(select).toHaveBeenCalledTimes(2);
    expect(result).toBe("t3.small");
  });

  it("skips category step when categoryHint is set (intent-based skip)", async () => {
    vi.mocked(select).mockResolvedValueOnce("t3.small");

    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(categoryField, {
      ...resolved,
      value: "t3.small",
      categoryHint: "burstable",
    });

    expect(select).toHaveBeenCalledTimes(1);
    expect(result).toBe("t3.small");
    expect(vi.mocked(log).info).toHaveBeenCalledWith(
      expect.stringContaining("Category auto-selected"),
    );
  });

  it("? at category level shows help note and re-prompts", async () => {
    vi.mocked(select)
      .mockResolvedValueOnce("?")
      .mockResolvedValueOnce("compute")
      .mockResolvedValueOnce("c5.large");

    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(categoryField, resolved);

    expect(vi.mocked(note)).toHaveBeenCalled();
    expect(result).toBe("c5.large");
  });

  it("non-TTY returns default value without prompting", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });

    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(categoryField, resolved);

    expect(select).not.toHaveBeenCalled();
    expect(result).toBe("t3.micro");
  });

  it("returns default when categories is empty", async () => {
    const emptyField: ResourceField = {
      name: "InstanceType",
      question: {
        type: "categorySelect",
        label: "Instance type",
        initialValue: "t3.micro",
        categories: [],
      },
    };

    const { renderOptionPrompt } = await import("./display.js");
    const result = await renderOptionPrompt(emptyField, resolved);

    expect(result).toBe("t3.micro");
  });

  it("all category labels include price range strings", () => {
    for (const cat of categoryField.question.categories!) {
      expect(cat.label).toMatch(/\$/);
    }
  });
});
