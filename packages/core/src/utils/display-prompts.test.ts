/**
 * Tests for renderOptionPrompt — back navigation consistency across all field types.
 *
 * Story: wizard-back-navigation-ux
 *
 * Ensures "← Back" is a visible, selectable option in every field type
 * (text, enum, multi, boolean, categorySelect) — no hidden typed keywords.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { ResourceField } from "../resource-plugins/types.js";
import type { ResolvedFieldConfig } from "../config/resource-policy.js";

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  multiselect: vi.fn(),
  autocomplete: vi.fn(),
  autocompleteMultiselect: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  note: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
}));

const { select, text, multiselect, confirm } = await import("@clack/prompts");
const {
  renderOptionPrompt,
  BACK_SENTINEL,
  HELP_SENTINEL,
  SKIP_SENTINEL,
  ENTER_VALUE_SENTINEL,
} = await import("./display-prompts.js");

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

const defaultResolved: ResolvedFieldConfig = {
  value: undefined,
  source: "plugin_default",
  policy: "none",
} as unknown as ResolvedFieldConfig;

function textField(overrides: Partial<ResourceField> = {}): ResourceField {
  return {
    name: "MyField",
    question: {
      type: "string",
      label: "My Field",
      placeholder: "enter-value",
    },
    ...overrides,
  } as ResourceField;
}

function enumField(): ResourceField {
  return {
    name: "Region",
    question: {
      type: "enum",
      label: "Region",
      options: [
        { value: "us-east-1", label: "US East" },
        { value: "eu-west-1", label: "EU West" },
      ],
    },
  } as ResourceField;
}

function multiField(): ResourceField {
  return {
    name: "SecurityGroupIds",
    question: {
      type: "multi",
      label: "Security Groups",
      options: [
        { value: "sg-1", label: "Web SG" },
        { value: "sg-2", label: "DB SG" },
      ],
    },
  } as ResourceField;
}

function booleanField(): ResourceField {
  return {
    name: "Encrypted",
    question: {
      type: "boolean",
      label: "Encrypted",
    },
  } as ResourceField;
}

function categorySelectField(): ResourceField {
  return {
    name: "InstanceType",
    question: {
      type: "categorySelect",
      label: "Instance type",
      initialValue: "t3.micro",
      categories: [
        {
          key: "burstable",
          label: "Burstable (t3/t4g)",
          options: [
            { value: "t3.micro", label: "t3.micro (2 vCPU, 1 GiB)" },
            { value: "t3.small", label: "t3.small (2 vCPU, 2 GiB)" },
          ],
        },
        {
          key: "general",
          label: "General Purpose (m5/m6i)",
          options: [{ value: "m5.large", label: "m5.large (2 vCPU, 8 GiB)" }],
        },
      ],
    },
  } as unknown as ResourceField;
}

describe("renderOptionPrompt — back navigation visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTTY(true);
  });

  describe("text fields", () => {
    it("shows action menu with Back option when showBack=true", async () => {
      vi.mocked(select).mockResolvedValueOnce(BACK_SENTINEL as never);

      const result = await renderOptionPrompt(
        textField(),
        defaultResolved,
        true,
      );

      expect(result).toBe(BACK_SENTINEL);
      // Select was called with action menu containing Back
      const call = vi.mocked(select).mock.calls[0]![0] as {
        options: Array<{ value: string; label: string }>;
      };
      const backOpt = call.options.find((o) => o.value === BACK_SENTINEL);
      expect(backOpt).toBeDefined();
      expect(backOpt!.label).toContain("Back");
      // clack.text was NOT called (user chose Back before entering value)
      expect(text).not.toHaveBeenCalled();
    });

    it("does NOT show action menu when showBack=false (first field)", async () => {
      vi.mocked(text).mockResolvedValueOnce("my-value" as never);

      const result = await renderOptionPrompt(
        textField(),
        defaultResolved,
        false,
      );

      expect(result).toBe("my-value");
      // select should NOT have been called — direct text input
      expect(select).not.toHaveBeenCalled();
      expect(text).toHaveBeenCalledOnce();
    });

    it("shows Skip option only for optional fields", async () => {
      vi.mocked(select).mockResolvedValueOnce(SKIP_SENTINEL as never);

      const optional = textField({ required: false });
      const result = await renderOptionPrompt(optional, defaultResolved, true);

      expect(result).toBeUndefined();
      const call = vi.mocked(select).mock.calls[0]![0] as {
        options: Array<{ value: string }>;
      };
      const skipOpt = call.options.find((o) => o.value === SKIP_SENTINEL);
      expect(skipOpt).toBeDefined();
    });

    it("hides Skip option for required fields", async () => {
      vi.mocked(select).mockResolvedValueOnce(ENTER_VALUE_SENTINEL as never);
      vi.mocked(text).mockResolvedValueOnce("required-value" as never);

      const required = textField({ required: true });
      await renderOptionPrompt(required, defaultResolved, true);

      const call = vi.mocked(select).mock.calls[0]![0] as {
        options: Array<{ value: string }>;
      };
      const skipOpt = call.options.find((o) => o.value === SKIP_SENTINEL);
      expect(skipOpt).toBeUndefined();
    });

    it("selecting Enter value proceeds to text input", async () => {
      vi.mocked(select).mockResolvedValueOnce(ENTER_VALUE_SENTINEL as never);
      vi.mocked(text).mockResolvedValueOnce("entered-value" as never);

      const result = await renderOptionPrompt(
        textField(),
        defaultResolved,
        true,
      );

      expect(result).toBe("entered-value");
      expect(select).toHaveBeenCalledOnce();
      expect(text).toHaveBeenCalledOnce();
    });

    it("typing 'back' in text input still returns BACK_SENTINEL (backcompat)", async () => {
      vi.mocked(select).mockResolvedValueOnce(ENTER_VALUE_SENTINEL as never);
      vi.mocked(text).mockResolvedValueOnce("back" as never);

      const result = await renderOptionPrompt(
        textField(),
        defaultResolved,
        true,
      );

      expect(result).toBe(BACK_SENTINEL);
    });

    it("selecting Help returns HELP_SENTINEL", async () => {
      vi.mocked(select).mockResolvedValueOnce(HELP_SENTINEL as never);

      const result = await renderOptionPrompt(
        textField(),
        defaultResolved,
        true,
      );

      expect(result).toBe(HELP_SENTINEL);
    });
  });

  describe("enum fields", () => {
    it("includes ← Back as a selectable option when showBack=true", async () => {
      vi.mocked(select).mockResolvedValueOnce(BACK_SENTINEL as never);

      const result = await renderOptionPrompt(
        enumField(),
        defaultResolved,
        true,
      );

      expect(result).toBe(BACK_SENTINEL);
      const call = vi.mocked(select).mock.calls[0]![0] as {
        options: Array<{ value: string }>;
      };
      expect(call.options.some((o) => o.value === BACK_SENTINEL)).toBe(true);
    });

    it("omits ← Back option when showBack=false", async () => {
      vi.mocked(select).mockResolvedValueOnce("us-east-1" as never);

      await renderOptionPrompt(enumField(), defaultResolved, false);

      const call = vi.mocked(select).mock.calls[0]![0] as {
        options: Array<{ value: string }>;
      };
      expect(call.options.some((o) => o.value === BACK_SENTINEL)).toBe(false);
    });
  });

  describe("multi fields", () => {
    it("includes ← Back as a selectable option when showBack=true", async () => {
      vi.mocked(multiselect).mockResolvedValueOnce([BACK_SENTINEL] as never);

      const result = await renderOptionPrompt(
        multiField(),
        defaultResolved,
        true,
      );

      // The caller (promptWithHelp) handles array-containing-BACK → BACK_SENTINEL
      // but renderOptionPrompt returns the array. Verify the option was offered.
      expect(result).toEqual([BACK_SENTINEL]);
      const call = vi.mocked(multiselect).mock.calls[0]![0] as {
        options: Array<{ value: string }>;
      };
      expect(call.options.some((o) => o.value === BACK_SENTINEL)).toBe(true);
    });
  });

  describe("boolean fields", () => {
    it("uses select (not confirm) when showBack=true to expose Back option", async () => {
      vi.mocked(select).mockResolvedValueOnce(BACK_SENTINEL as never);

      const result = await renderOptionPrompt(
        booleanField(),
        defaultResolved,
        true,
      );

      expect(result).toBe(BACK_SENTINEL);
      expect(select).toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      const call = vi.mocked(select).mock.calls[0]![0] as {
        options: Array<{ value: string }>;
      };
      expect(call.options.some((o) => o.value === BACK_SENTINEL)).toBe(true);
    });

    it("uses clack.confirm when showBack=false (first field)", async () => {
      vi.mocked(confirm).mockResolvedValueOnce(true as never);

      await renderOptionPrompt(booleanField(), defaultResolved, false);

      expect(confirm).toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
    });
  });

  describe("multi fields (additional coverage)", () => {
    it("omits ← Back option when showBack=false", async () => {
      vi.mocked(multiselect).mockResolvedValueOnce(["sg-1"] as never);

      await renderOptionPrompt(multiField(), defaultResolved, false);

      const call = vi.mocked(multiselect).mock.calls[0]![0] as {
        options: Array<{ value: string }>;
      };
      expect(call.options.some((o) => o.value === BACK_SENTINEL)).toBe(false);
    });
  });

  describe("categorySelect fields (Story wizard-back-navigation-ux AC #1)", () => {
    it("includes ← Back in Step 1 (category selection) when showBack=true", async () => {
      // User selects Back from the category menu
      vi.mocked(select).mockResolvedValueOnce(BACK_SENTINEL as never);

      const result = await renderOptionPrompt(
        categorySelectField(),
        defaultResolved,
        true,
      );

      expect(result).toBe(BACK_SENTINEL);
      // First select call is the category step — verify Back option present
      const call = vi.mocked(select).mock.calls[0]![0] as {
        options: Array<{ value: string; label: string }>;
      };
      expect(call.options.some((o) => o.value === BACK_SENTINEL)).toBe(true);
    });

    it("omits ← Back in Step 1 when showBack=false (first field)", async () => {
      vi.mocked(select)
        .mockResolvedValueOnce("burstable" as never) // category
        .mockResolvedValueOnce("t3.micro" as never); // size

      await renderOptionPrompt(categorySelectField(), defaultResolved, false);

      const categoryCall = vi.mocked(select).mock.calls[0]![0] as {
        options: Array<{ value: string }>;
      };
      expect(categoryCall.options.some((o) => o.value === BACK_SENTINEL)).toBe(
        false,
      );
    });

    it("Back in Step 2 (size selection) loops back to Step 1 (category)", async () => {
      vi.mocked(select)
        .mockResolvedValueOnce("burstable" as never) // Step 1: category
        .mockResolvedValueOnce(BACK_SENTINEL as never) // Step 2: Back → loop
        .mockResolvedValueOnce("general" as never) // Step 1 again: different category
        .mockResolvedValueOnce("m5.large" as never); // Step 2: final selection

      const result = await renderOptionPrompt(
        categorySelectField(),
        defaultResolved,
        true,
      );

      expect(result).toBe("m5.large");
      // Expect 4 select calls (1 category, 2 size, 1 category re-show, 1 size)
      // Actually: category1 → size1(back) → category2 → size2 = 4 calls
      expect(vi.mocked(select)).toHaveBeenCalledTimes(4);
    });

    it("normal selection without Back returns the chosen value", async () => {
      vi.mocked(select)
        .mockResolvedValueOnce("general" as never) // category
        .mockResolvedValueOnce("m5.large" as never); // size

      const result = await renderOptionPrompt(
        categorySelectField(),
        defaultResolved,
        true,
      );

      expect(result).toBe("m5.large");
    });
  });

  describe("cancel handling (Ctrl+C)", () => {
    it("throws UserCancelledError when action menu is cancelled", async () => {
      const cancelSym = Symbol("cancel");
      vi.mocked(select).mockResolvedValueOnce(cancelSym as never);
      // Mock isCancel to return true for this symbol
      const clack = await import("@clack/prompts");
      vi.mocked(clack.isCancel).mockReturnValueOnce(true);

      await expect(
        renderOptionPrompt(textField(), defaultResolved, true),
      ).rejects.toThrow();
    });
  });

  describe("non-TTY mode", () => {
    it("skips all prompts and returns resolved default", async () => {
      setTTY(false);
      const resolved = {
        value: "default",
        source: "plugin_default",
        policy: "none",
      } as unknown as ResolvedFieldConfig;

      const result = await renderOptionPrompt(textField(), resolved, true);

      expect(result).toBe("default");
      expect(select).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
    });
  });
});
