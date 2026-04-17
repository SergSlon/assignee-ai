/**
 * Category-select question handler (Story 18.12).
 * Two-step category → size selection for grouped options.
 */
import * as clack from "@clack/prompts";
import { UserCancelledError } from "../../errors.js";
import type { ResourceField } from "../../resource-plugins/types.js";
import type { ResolvedFieldConfig } from "../../config/resource-policy.js";
import { UserMessage } from "../../config/constants/ui.js";
import { BACK_SENTINEL, HELP_SENTINEL, OTHER_SENTINEL } from "./sentinels.js";
import type { BackOption } from "./shared-helpers.js";

type CategoriesType = NonNullable<ResourceField["question"]["categories"]>;
type Category = CategoriesType[number];

async function selectCategory(
  field: ResourceField,
  categories: CategoriesType,
  backOption: BackOption[],
): Promise<string | typeof BACK_SENTINEL | typeof OTHER_SENTINEL> {
  const { question } = field;
  // Category select loop (supports ? help)
  while (true) {
    const categoryResult = (await clack.select({
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

    if (categoryResult === OTHER_SENTINEL) {
      return OTHER_SENTINEL;
    }

    return categoryResult as string;
  }
}

async function selectSize(
  field: ResourceField,
  selectedCategory: Category,
  defaultValue: unknown,
): Promise<unknown> {
  const { question } = field;
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

  return clack.select({
    message: `${question.label} — ${selectedCategory.label.split(" — ")[0]}`,
    options: sizeOptions,
    initialValue: sizeInitial,
  });
}

export async function promptCategorySelect(
  field: ResourceField,
  resolved: ResolvedFieldConfig,
  defaultValue: unknown,
  backOption: BackOption[],
): Promise<unknown> {
  const categories = field.question.categories;
  if (!categories || categories.length === 0) {
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
        break;
      }
    }
  }

  let result: unknown;
  // Outer loop: Back in Step 2 returns to Step 1 (category selection)
  categoryLoop: while (true) {
    if (!skipCategory) {
      const categoryResult = await selectCategory(
        field,
        categories,
        backOption,
      );
      if (categoryResult === BACK_SENTINEL) return BACK_SENTINEL;
      if (categoryResult === OTHER_SENTINEL) return OTHER_SENTINEL;
      selectedCategoryKey = categoryResult;
    } else {
      // Show info that category was auto-selected
      const matchedCat = categories.find((c) => c.key === selectedCategoryKey);
      if (matchedCat) {
        clack.log.info(
          `Category auto-selected: ${matchedCat.label} — based on your intent`,
        );
      }
    }

    const selectedCategory = categories.find(
      (c) => c.key === selectedCategoryKey,
    );
    if (!selectedCategory) {
      return defaultValue;
    }

    result = await selectSize(field, selectedCategory, defaultValue);

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
  return result;
}
