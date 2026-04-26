/**
 * Thin re-export shim — canonical implementations live in
 * `@assignee/core/utils/display` (Story 50-4 Wave 5 Pass C-2).
 *
 * Owns ALL terminal formatting — no inline chalk in command files.
 * Non-TTY fallback: plain text without ANSI when !process.stdout.isTTY
 * (CI/pipes).
 */
export {
  // findings
  formatFindings,
  formatFreeTierNote,
  formatMemoryHints,
  // plan
  renderPlanBox,
  formatCostLine,
  formatPricingBreakdown,
  formatAppliedFixes,
  formatFixValue,
  formatAutoFixHint,
  regionLabel,
  // prompts
  renderHitlConfirm,
  renderHitlCompoundConfirm,
  renderAdvancedConfirm,
  renderOptionPrompt,
  BACK_SENTINEL,
  HELP_SENTINEL,
  OTHER_SENTINEL,
  REVIEW_SENTINEL,
  runReviewAnswers,
  // output
  renderIntro,
  renderOutro,
  renderError,
  renderApplySuccess,
  renderCompoundSuccess,
  renderCompoundPartialFailure,
  renderSecurityWarnings,
  renderDependencyPlan,
  renderResourceTable,
  renderEmptyList,
  renderStatusSummary,
  renderEmptyStatus,
  startSpinner,
  updateSpinner,
  stopSpinner,
  // docs
  renderDocHelp,
  renderTradeoffHelp,
  fetchDocText,
  synthesizeDocHint,
  // fix selection
  promptFixSelection,
  type FixSelectionResult,
  // helpers — formatting
  FRIENDLY_NAMES,
  FRIENDLY_NAMES_BY_TYPE,
  SENSITIVE_FIELDS,
  resolveFieldLabel,
  resolveSetKey,
  spacePascalCase,
  formatValue,
  formatSpecialValue,
  formatDesiredState,
  type RenderableState,
  type RenderableCompoundQueue,
} from "@assignee/core";
