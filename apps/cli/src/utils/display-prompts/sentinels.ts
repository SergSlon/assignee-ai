/**
 * Wizard prompt sentinel values — single source of truth.
 * Shared across every option-prompt handler (boolean/enum/string/multi/category).
 */
export const BACK_SENTINEL = "__back__" as const;
export const HELP_SENTINEL = "?" as const;
export const OTHER_SENTINEL = "__other__" as const;
export const SKIP_SENTINEL = "__skip__" as const;
/** Sentinel used inside the text-field action menu for the "Enter value" option. */
export const ENTER_VALUE_SENTINEL = "__enter_value__" as const;
/**
 * Sentinel returned by a wizard action menu when the user picks
 * "Review answers so far". Handled at the `runPromptLoop` level which
 * opens the review UI and (optionally) routes to an edit-by-index re-prompt.
 * @see Story 48.7
 */
export const REVIEW_SENTINEL = "__review__" as const;
