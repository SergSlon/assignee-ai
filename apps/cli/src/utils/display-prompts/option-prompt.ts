/**
 * Option-prompt dispatcher.
 *
 * Renders an interactive prompt for a single resource field by selecting
 * the appropriate @clack/prompts primitive for the field's question type.
 * Non-TTY: returns resolved default without prompting (CI-safe).
 * Cancel: returns resolved default as graceful fallback.
 */
import * as clack from "@clack/prompts";
import {
  AssigneeError,
  UserCancelledError,
  QuestionTypeName,
  type ResourceField,
  type ResolvedFieldConfig,
} from "@assignee/core";
import { UserMessage } from "../../config/constants.js";
import { BACK_SENTINEL, HELP_SENTINEL, REVIEW_SENTINEL } from "./sentinels.js";
import {
  buildBackOption,
  buildReviewOption,
  maybeShowHint,
} from "./shared-helpers.js";
import { promptBoolean } from "./option-boolean.js";
import { promptEnum } from "./option-enum.js";
import { promptString } from "./option-string.js";
import { promptMulti } from "./option-multi.js";
import { promptCategorySelect } from "./option-category.js";

export async function renderOptionPrompt(
  field: ResourceField,
  resolved: ResolvedFieldConfig,
  showBack = false,
  answers?: Record<string, unknown>,
): Promise<unknown> {
  const defaultValue = resolved.value ?? field.question.initialValue;

  if (!process.stdin.isTTY) return defaultValue;

  const backOption = buildBackOption(showBack);
  const hasAnswers = !!answers && Object.keys(answers).length > 0;
  const reviewOption = buildReviewOption(showBack, hasAnswers);
  const menuExtras = [...backOption, ...reviewOption];
  maybeShowHint(field);

  const { question } = field;
  let result: unknown;

  switch (question.type) {
    case "boolean":
      result = await promptBoolean(field, defaultValue, menuExtras, showBack);
      break;
    case "enum":
      result = await promptEnum(field, defaultValue, menuExtras);
      break;
    case "string": {
      const stringResult = await promptString(
        field,
        defaultValue,
        showBack,
        answers,
        hasAnswers,
      );
      // promptString may short-circuit with sentinel values — return them directly.
      if (
        stringResult === BACK_SENTINEL ||
        stringResult === REVIEW_SENTINEL ||
        stringResult === HELP_SENTINEL ||
        stringResult === undefined
      ) {
        return stringResult;
      }
      result = stringResult;
      break;
    }
    case "multi": {
      const multiResult = await promptMulti(field, menuExtras);
      if (multiResult === undefined) return undefined;
      // "__other__" branch resolves inside promptMulti and may already be
      // the final array — return it here so sentinel post-processing below
      // doesn't coerce it through the clack.isCancel gate.
      if (Array.isArray(multiResult)) return multiResult;
      result = multiResult;
      break;
    }
    case QuestionTypeName.CATEGORY_SELECT:
      result = await promptCategorySelect(
        field,
        resolved,
        defaultValue,
        menuExtras,
      );
      break;
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
    if (result === REVIEW_SENTINEL) return REVIEW_SENTINEL;
    return result === "true";
  }

  // Treat empty string inputs (e.g., just pressing Enter on optional fields) as skipped.
  if (typeof result === "string" && result.trim() === "") {
    return undefined;
  }

  return result;
}
