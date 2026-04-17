/**
 * Barrel for display-prompts/ sub-modules.
 * Entrypoint: wires the option-prompt dispatcher to its per-question-type
 * handlers (boolean/enum/string/multi/category) and re-exports every
 * confirm wrapper, sentinel, and the dispatcher itself so the old
 * display-prompts.ts surface keeps working.
 */
export {
  BACK_SENTINEL,
  HELP_SENTINEL,
  OTHER_SENTINEL,
  SKIP_SENTINEL,
  ENTER_VALUE_SENTINEL,
  REVIEW_SENTINEL,
} from "./sentinels.js";
export { runReviewAnswers } from "./review-answers.js";
export {
  renderHitlConfirm,
  renderHitlCompoundConfirm,
  renderAdvancedConfirm,
  renderApplyNowConfirm,
} from "./confirms.js";
export { renderOptionPrompt } from "./option-prompt.js";
