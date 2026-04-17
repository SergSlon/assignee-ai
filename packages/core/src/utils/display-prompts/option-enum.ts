/**
 * Enum question handler.
 *
 * Wave-2 P1 (team-C #14): policy is ">10" but threshold was off-by-two
 * at 12, so 11-12 option lists rendered as a bare `select` without search.
 * Lowered to match `feedback_long_lists_ux` (>10 → autocomplete).
 */
import * as clack from "@clack/prompts";
import type { ResourceField } from "../../resource-plugins/types.js";
import { HELP_SENTINEL, OTHER_SENTINEL } from "./sentinels.js";
import type { BackOption } from "./shared-helpers.js";

export async function promptEnum(
  field: ResourceField,
  defaultValue: unknown,
  backOption: BackOption[],
): Promise<unknown> {
  const { question } = field;
  const enumOptions = [
    ...backOption,
    ...(question.options ?? []).map((o) => ({
      value: o.value,
      label: o.label,
    })),
    { value: OTHER_SENTINEL, label: "Other \u2014 enter manually" },
    { value: HELP_SENTINEL, label: "\u2753 ? \u2014 explain this field" },
  ];
  // >10 threshold — preserve Wave-2 F6b autocomplete-on-long-lists behavior.
  if (enumOptions.length > 10) {
    return clack.autocomplete({
      message: `${question.label} (type to search)`,
      options: enumOptions,
      initialValue: typeof defaultValue === "string" ? defaultValue : undefined,
    });
  }
  return clack.select({
    message: question.label,
    options: enumOptions,
    initialValue: typeof defaultValue === "string" ? defaultValue : undefined,
  });
  // "__other__" is returned as-is — promptWithHelp handles LLM-assisted input
}
