/**
 * Shared helpers for option-prompt handlers — back-option builder + hint note.
 */
import * as clack from "@clack/prompts";
import type { ResourceField } from "../../resource-plugins/types.js";
import { BACK_SENTINEL, REVIEW_SENTINEL } from "./sentinels.js";

export interface BackOption {
  value: string;
  label: string;
}

export function buildBackOption(showBack: boolean): BackOption[] {
  return showBack
    ? [
        {
          value: BACK_SENTINEL,
          label: "\u2190 Back \u2014 return to previous field",
        },
      ]
    : [];
}

/**
 * Build the "Review answers so far" menu option.
 *
 * Shown only when (a) the wizard is in back-navigation mode (`showBack`) and
 * (b) at least one answer has been recorded (`hasAnswers`). This avoids noise
 * like "Review (0 answers)" on the very first prompt and keeps the affordance
 * out of non-interactive / expert flows.
 *
 * @see Story 48.7
 */
export function buildReviewOption(
  showBack: boolean,
  hasAnswers: boolean,
): BackOption[] {
  return showBack && hasAnswers
    ? [
        {
          value: REVIEW_SENTINEL,
          label: "\ud83d\udccb Review answers so far",
        },
      ]
    : [];
}

/** Display contextual hint before the prompt if present (Story 10.2). */
export function maybeShowHint(field: ResourceField): void {
  if (field.question.hint && process.stdout.isTTY) {
    clack.note(field.question.hint, field.name);
  }
}
