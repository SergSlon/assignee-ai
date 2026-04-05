/**
 * Interactive prompt helpers for Assignee.ai CLI.
 * Extracted from display.ts — renderHitlConfirm, renderHitlCompoundConfirm,
 * renderApplyNowConfirm, renderAdvancedConfirm, renderOptionPrompt.
 */

import * as clack from "@clack/prompts";
import {
  AssigneeError,
  UserCancelledError,
  QuestionTypeName,
  CostEstimateLabel,
  type ResourceField,
  type ResolvedFieldConfig,
  type ArchitecturePattern,
} from "@assignee/core";
import type { RenderableState } from "./display.js";
import { UserMessage } from "../config/constants.js";

/** Wizard prompt sentinel values — single source of truth. */
export const BACK_SENTINEL = "__back__" as const;
export const HELP_SENTINEL = "?" as const;
export const OTHER_SENTINEL = "__other__" as const;

export async function renderHitlConfirm(
  state: RenderableState,
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // Non-TTY: safe default is decline
    return false;
  }

  const result = await clack.confirm({
    message: `Apply this plan to create ${state.resourceType}?`,
    initialValue: true,
  });

  if (clack.isCancel(result)) {
    clack.cancel(UserMessage.CANCELLED);
    throw new UserCancelledError();
  }
  return result === true;
}

/**
 * Prompts user to approve a compound multi-resource provisioning plan.
 * Uses the same @clack/prompts confirm() as the single-resource renderHitlConfirm.
 * Non-TTY: safe default is decline.
 *
 * @param pattern - The architecture pattern for display context
 * @param resourceCount - Number of resources to be provisioned
 */
export async function renderHitlCompoundConfirm(
  pattern: ArchitecturePattern,
  resourceCount: number,
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  const result = await clack.confirm({
    message: `Apply this compound plan to provision ${resourceCount} resource${resourceCount === 1 ? "" : "s"} (${pattern.displayName})?`,
    initialValue: true,
  });

  if (clack.isCancel(result)) {
    clack.cancel(UserMessage.CANCELLED);
    throw new UserCancelledError();
  }
  return result === true;
}

/**
 * Prompts user to opt into configuring advanced fields.
 * Non-TTY: returns false (CI-safe).
 */
export async function renderAdvancedConfirm(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const result = await clack.confirm({
    message:
      "Configure advanced options? (No = secure defaults applied automatically)",
    initialValue: false,
  });
  if (clack.isCancel(result)) {
    clack.cancel(UserMessage.CANCELLED);
    throw new UserCancelledError();
  }
  return result === true;
}

/**
 * Prompts user to apply the plan immediately after display.
 * Non-TTY: returns false (CI-safe — auto-decline).
 *
 * @see Story 10.3, FR-20
 */
export async function renderApplyNowConfirm(
  state: RenderableState,
): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  const result = await clack.confirm({
    message: `Apply now? (${state.resourceType}, est. ${state.estimatedMonthlyCost ?? CostEstimateLabel.NA}/mo)`,
    initialValue: true,
  });

  if (clack.isCancel(result)) {
    clack.cancel(UserMessage.CANCELLED);
    throw new UserCancelledError();
  }
  return result === true;
}

/**
 * Renders an interactive prompt for a single resource field.
 * Dispatches to the correct @clack/prompts primitive based on question type.
 * Non-TTY: returns resolved default without prompting (CI-safe).
 * Cancel: returns resolved default as graceful fallback.
 */
export async function renderOptionPrompt(
  field: ResourceField,
  resolved: ResolvedFieldConfig,
  showBack = false,
  answers?: Record<string, unknown>,
): Promise<unknown> {
  const defaultValue = resolved.value ?? field.question.initialValue;

  if (!process.stdin.isTTY) return defaultValue;

  const backOption = showBack
    ? [
        {
          value: BACK_SENTINEL,
          label: "\u2190 Back \u2014 return to previous field",
        },
      ]
    : [];

  // Display contextual hint before the prompt if present (Story 10.2)
  if (field.question.hint && process.stdout.isTTY) {
    clack.note(field.question.hint, field.name);
  }

  const { question } = field;
  let result: unknown;

  switch (question.type) {
    case "boolean": {
      // Use select instead of confirm so the user can pick '?' to get field help.
      // The '?' sentinel is caught by promptWithHelp, which shows docs and re-prompts.
      const boolDefault =
        defaultValue === true || defaultValue === "true" ? "true" : "false";
      result = await clack.select({
        message: question.label,
        options: [
          ...backOption,
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
          { value: HELP_SENTINEL, label: "\u2753 ? \u2014 explain this field" },
        ],
        initialValue: boolDefault,
      });
      break;
    }
    case "enum": {
      const enumOptions = [
        ...backOption,
        ...(question.options ?? []).map((o) => ({
          value: o.value,
          label: o.label,
        })),
        { value: OTHER_SENTINEL, label: "Other \u2014 enter manually" },
        { value: HELP_SENTINEL, label: "\u2753 ? \u2014 explain this field" },
      ];
      // Use searchable autocomplete for large option lists (>10 items)
      if (enumOptions.length > 12) {
        result = await clack.autocomplete({
          message: `${question.label} (type to search)`,
          options: enumOptions,
          initialValue:
            typeof defaultValue === "string" ? defaultValue : undefined,
        });
      } else {
        result = await clack.select({
          message: question.label,
          options: enumOptions,
          initialValue:
            typeof defaultValue === "string" ? defaultValue : undefined,
        });
      }
      // "__other__" is returned as-is — promptWithHelp handles LLM-assisted input
      break;
    }
    case "string": {
      const placeholder = showBack
        ? "Type value (or 'back' to return to previous field)"
        : (question.placeholder ?? "");
      result = await clack.text({
        message: question.label,
        placeholder,
        initialValue:
          typeof defaultValue === "string" ? defaultValue : undefined,
        validate: (value) => {
          if (value === HELP_SENTINEL) return undefined; // Bypass validation for field help
          if (showBack && value?.toLowerCase() === "back") return undefined;
          return question.validate?.(value, answers);
        },
      });
      // Handle "back" typed in text field
      if (
        showBack &&
        typeof result === "string" &&
        result.toLowerCase() === "back"
      ) {
        return BACK_SENTINEL;
      }
      break;
    }
    case "multi": {
      // clack multiselect crashes with an empty options array.
      // Plugins define Tags with options: [] as a placeholder — real options come
      // from org policy config (Story 7.2). Until 7.2 ships, multi fields with no
      // options are silently skipped (returned as undefined → not stored in elicitedOptions).
      if (!question.options || question.options.length === 0) {
        return undefined;
      }
      const multiOptions = [
        ...backOption,
        {
          value: HELP_SENTINEL,
          label: "\u2753 ? \u2014 explain these options",
        },
        ...question.options.map((o) => ({
          value: o.value,
          label: o.label,
        })),
        { value: OTHER_SENTINEL, label: "Other \u2014 enter manually" },
      ];
      // Use searchable autocomplete multiselect for large lists
      if (multiOptions.length > 12) {
        result = await clack.autocompleteMultiselect({
          message: `${question.label} (type to search)`,
          options: multiOptions,
          required: false,
        });
      } else {
        result = await clack.multiselect({
          message: question.label,
          options: multiOptions,
          required: false,
        });
      }
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
      break;
    }
    case QuestionTypeName.CATEGORY_SELECT: {
      // Story 18.12: Two-step category → size selection for grouped options.
      const categories = question.categories;
      if (!categories || categories.length === 0) {
        // Fallback: treat as flat enum if no categories defined
        return defaultValue;
      }

      // Determine if we can skip the category step via intent-based categoryHint
      // or by finding which category the default value belongs to.
      let selectedCategoryKey: string | undefined = resolved.categoryHint;
      let skipCategory = !!selectedCategoryKey;

      // If no explicit categoryHint but we have a default value, find its category
      if (!selectedCategoryKey && typeof defaultValue === "string") {
        for (const cat of categories) {
          if (cat.options.some((o) => o.value === defaultValue)) {
            // Don't auto-skip when only initialValue is set (no intent match)
            // Only pre-select if there's a categoryHint
            break;
          }
        }
      }

      // Outer loop: Back in Step 2 returns to Step 1 (category selection)
      categoryLoop: while (true) {
        // Step 1: Category selection (unless skipped by intent)
        if (!skipCategory) {
          let categoryResult: string | symbol;

          // Category select loop (supports ? help)
          while (true) {
            categoryResult = (await clack.select({
              message: `${question.label} — Choose a category`,
              options: [
                ...backOption,
                ...categories.map((cat) => ({
                  value: cat.key,
                  label: cat.label,
                  hint: cat.description,
                })),
                {
                  value: OTHER_SENTINEL,
                  label: "Other \u2014 enter any instance type manually",
                },
                {
                  value: HELP_SENTINEL,
                  label: "\u2753 ? \u2014 explain this field",
                },
              ],
              initialValue: categories[0]?.key,
            })) as string | symbol;

            if (clack.isCancel(categoryResult)) {
              clack.cancel(UserMessage.WIZARD_CANCELLED);
              throw new UserCancelledError();
            }

            if (categoryResult === BACK_SENTINEL) return BACK_SENTINEL;

            if (categoryResult === HELP_SENTINEL) {
              const helpLines = categories
                .map((cat) => `${cat.label}\n  ${cat.description}`)
                .join("\n\n");
              clack.note(helpLines, "Instance Type Categories");
              continue;
            }

            // "Other" — return sentinel so promptWithHelp handles LLM-assisted input
            if (categoryResult === OTHER_SENTINEL) {
              return OTHER_SENTINEL;
            }

            selectedCategoryKey = categoryResult as string;
            break;
          }
        } else {
          // Show info that category was auto-selected
          const matchedCat = categories.find(
            (c) => c.key === selectedCategoryKey,
          );
          if (matchedCat) {
            clack.log.info(
              `Category auto-selected: ${matchedCat.label} — based on your intent`,
            );
          }
        }

        // Step 2: Size selection within the selected category
        const selectedCategory = categories.find(
          (c) => c.key === selectedCategoryKey,
        );
        if (!selectedCategory) {
          return defaultValue;
        }

        const sizeOptions = [
          {
            value: BACK_SENTINEL,
            label: "\u2190 Back \u2014 return to category selection",
          },
          ...selectedCategory.options.map((o) => ({
            value: o.value,
            label: o.label,
          })),
          {
            value: OTHER_SENTINEL,
            label: "Other \u2014 enter size manually",
          },
          { value: HELP_SENTINEL, label: "\u2753 ? \u2014 explain this field" },
        ];

        // Pre-select the default if it exists in this category, otherwise first option
        const sizeInitial =
          typeof defaultValue === "string" &&
          selectedCategory.options.some((o) => o.value === defaultValue)
            ? defaultValue
            : selectedCategory.options[0]?.value;

        result = await clack.select({
          message: `${question.label} — ${selectedCategory.label.split(" — ")[0]}`,
          options: sizeOptions,
          initialValue: sizeInitial,
        });

        if (clack.isCancel(result)) {
          clack.cancel(UserMessage.WIZARD_CANCELLED);
          throw new UserCancelledError();
        }

        // Back in Step 2 loops back to Step 1 (category selection)
        if (result === BACK_SENTINEL) {
          skipCategory = false;
          selectedCategoryKey = undefined;
          continue categoryLoop;
        }
        // "__other__" or actual value — exit the category loop
        break;
      }
      break;
    }
    default: {
      const _exhaustive: never = question.type;
      throw new AssigneeError(
        `Unknown question type: ${String(_exhaustive)}`,
        "UNKNOWN_QUESTION_TYPE",
      );
    }
  }

  if (clack.isCancel(result)) {
    clack.cancel(UserMessage.WIZARD_CANCELLED);
    throw new UserCancelledError();
  }

  // Normalise boolean-select results back to actual booleans.
  // The boolean case uses clack.select which returns "true"/"false" strings,
  // but the rest of the app expects actual boolean values.
  if (question.type === "boolean") {
    if (result === HELP_SENTINEL) return HELP_SENTINEL;
    if (result === BACK_SENTINEL) return BACK_SENTINEL;
    return result === "true";
  }

  // Treat empty string inputs (e.g., just pressing Enter on optional fields) as skipped.
  if (typeof result === "string" && result.trim() === "") {
    return undefined;
  }

  return result;
}
