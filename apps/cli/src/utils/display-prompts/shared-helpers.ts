/**
 * Shared helpers for option-prompt handlers — back-option builder + hint note.
 */
import * as clack from "@clack/prompts";
import type { ResourceField } from "@assignee/core";
import { BACK_SENTINEL } from "./sentinels.js";

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

/** Display contextual hint before the prompt if present (Story 10.2). */
export function maybeShowHint(field: ResourceField): void {
  if (field.question.hint && process.stdout.isTTY) {
    clack.note(field.question.hint, field.name);
  }
}
