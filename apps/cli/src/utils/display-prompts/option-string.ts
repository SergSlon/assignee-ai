/**
 * String question handler.
 *
 * Two-step flow in --wizard mode with showBack:
 * 1. Select: [Enter value] [← Back] [? Help] [Skip]
 * 2. If user picks "Enter value", fall through to clack.text()
 *
 * This makes Back a visible, discoverable option instead of a hidden
 * "type 'back'" keyword. Keyboard shortcut: typing "back" in the text
 * input still works for power users (backward compatible).
 */
import * as clack from "@clack/prompts";
import { UserCancelledError, type ResourceField } from "@assignee/core";
import { UserMessage } from "../../config/constants.js";
import {
  BACK_SENTINEL,
  HELP_SENTINEL,
  SKIP_SENTINEL,
  ENTER_VALUE_SENTINEL,
  REVIEW_SENTINEL,
} from "./sentinels.js";

async function runActionMenu(
  field: ResourceField,
  hasAnswers: boolean,
): Promise<string | symbol | undefined> {
  const actionOptions: Array<{ value: string; label: string }> = [
    { value: ENTER_VALUE_SENTINEL, label: "Enter value" },
    {
      value: BACK_SENTINEL,
      label: "\u2190 Back \u2014 return to previous field",
    },
  ];
  if (hasAnswers) {
    actionOptions.push({
      value: REVIEW_SENTINEL,
      label: "\ud83d\udccb Review answers so far",
    });
  }
  actionOptions.push({
    value: HELP_SENTINEL,
    label: "\u2753 ? \u2014 explain this field",
  });
  if (!field.required) {
    actionOptions.push({
      value: SKIP_SENTINEL,
      label: "Skip (leave empty)",
    });
  }

  const action = await clack.select({
    message: field.question.label,
    options: actionOptions,
    initialValue: ENTER_VALUE_SENTINEL,
  });

  if (clack.isCancel(action)) {
    clack.cancel(UserMessage.WIZARD_CANCELLED);
    throw new UserCancelledError();
  }
  return action;
}

export async function promptString(
  field: ResourceField,
  defaultValue: unknown,
  showBack: boolean,
  answers?: Record<string, unknown>,
  hasAnswers = false,
): Promise<unknown> {
  const { question } = field;

  if (showBack) {
    const action = await runActionMenu(field, hasAnswers);
    if (action === BACK_SENTINEL) return BACK_SENTINEL;
    if (action === REVIEW_SENTINEL) return REVIEW_SENTINEL;
    if (action === HELP_SENTINEL) return HELP_SENTINEL;
    if (action === SKIP_SENTINEL) return undefined;
    // action === ENTER_VALUE_SENTINEL — fall through to clack.text()
  }

  // Fix: don't leak the back hint into the placeholder when there's no
  // real placeholder. The action menu already told the user Back is an
  // option; showing " (or type 'back' to go back)" as a standalone
  // placeholder would be noisy and confusing.
  const placeholder = question.placeholder ?? "";
  const result = await clack.text({
    message: question.label,
    placeholder,
    initialValue: typeof defaultValue === "string" ? defaultValue : undefined,
    validate: (value) => {
      if (value === HELP_SENTINEL) return undefined;
      if (showBack && value?.toLowerCase() === "back") return undefined;
      return question.validate?.(value, answers);
    },
  });
  // Backcompat: typed "back" in text field returns BACK_SENTINEL
  if (
    showBack &&
    typeof result === "string" &&
    result.toLowerCase() === "back"
  ) {
    return BACK_SENTINEL;
  }
  return result;
}
