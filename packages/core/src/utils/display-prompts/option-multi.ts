/**
 * Multi-select question handler.
 *
 * clack multiselect crashes with an empty options array. Plugins define
 * Tags with options: [] as a placeholder — real options come from org
 * policy config (Story 7.2). Until 7.2 ships, multi fields with no
 * options are silently skipped.
 *
 * Wave-2 P1: searchable autocomplete multiselect for >10 options.
 */
import * as clack from "@clack/prompts";
import { UserCancelledError } from "../../errors.js";
import type { ResourceField } from "../../resource-plugins/types.js";
import { UserMessage } from "../../config/constants/ui.js";
import { HELP_SENTINEL, OTHER_SENTINEL } from "./sentinels.js";
import type { BackOption } from "./shared-helpers.js";

async function runMultiselect(
  field: ResourceField,
  backOption: BackOption[],
): Promise<unknown> {
  const { question } = field;
  const multiOptions = [
    ...backOption,
    {
      value: HELP_SENTINEL,
      label: "\u2753 ? \u2014 explain these options",
    },
    ...(question.options ?? []).map((o) => ({
      value: o.value,
      label: o.label,
    })),
    { value: OTHER_SENTINEL, label: "Other \u2014 enter manually" },
  ];
  // >10 threshold — preserve Wave-2 F6b autocomplete-on-long-lists behavior.
  if (multiOptions.length > 10) {
    return clack.autocompleteMultiselect({
      message: `${question.label} (type to search)`,
      options: multiOptions,
      required: false,
    });
  }
  return clack.multiselect({
    message: question.label,
    options: multiOptions,
    required: false,
  });
}

export async function promptMulti(
  field: ResourceField,
  backOption: BackOption[],
): Promise<unknown> {
  const { question } = field;
  if (!question.options || question.options.length === 0) {
    return undefined;
  }

  const result = await runMultiselect(field, backOption);

  // If user selected "__other__", prompt for comma-separated custom values
  if (Array.isArray(result) && result.includes(OTHER_SENTINEL)) {
    const otherValues = result.filter((v: string) => v !== OTHER_SENTINEL);
    const customInput = await clack.text({
      message: `${question.label} \u2014 Enter additional values (comma-separated)`,
      placeholder: "value1, value2",
    });
    if (clack.isCancel(customInput)) {
      clack.cancel(UserMessage.WIZARD_CANCELLED);
      throw new UserCancelledError();
    }
    if (typeof customInput === "string" && customInput.trim()) {
      const customValues = customInput
        .split(",")
        .map((v: string) => v.trim())
        .filter(Boolean);
      return [...otherValues, ...customValues];
    }
    return otherValues;
  }
  return result;
}
