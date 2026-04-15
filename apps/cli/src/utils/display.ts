/**
 * Terminal display layer for Assignee.ai CLI.
 * Owns ALL terminal formatting — no inline chalk in command files.
 *
 * Non-TTY fallback: plain text without ANSI when !process.stdout.isTTY (CI/pipes).
 *
 * This barrel module re-exports everything from the focused sub-modules
 * so that existing imports (`from "../utils/display.js"`) continue to work.
 */

// ── Re-exports from sub-modules (barrel) ────────────────────────────────────

export {
  formatFindings,
  formatFreeTierNote,
  formatMemoryHints,
} from "./display-findings.js";

export {
  renderPlanBox,
  formatCostLine,
  formatPricingBreakdown,
  formatAppliedFixes,
  formatFixValue,
  formatAutoFixHint,
  regionLabel,
} from "./display-plan.js";

export {
  renderHitlConfirm,
  renderHitlCompoundConfirm,
  renderApplyNowConfirm,
  renderAdvancedConfirm,
  renderOptionPrompt,
  BACK_SENTINEL,
  HELP_SENTINEL,
  OTHER_SENTINEL,
} from "./display-prompts.js";

export {
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
} from "./display-output.js";

export {
  renderDocHelp,
  renderTradeoffHelp,
  fetchDocText,
  synthesizeDocHint,
} from "./display-docs.js";

// Re-export promptFixSelection from its own module (Story 35.4)
export {
  promptFixSelection,
  type FixSelectionResult,
} from "./fix-selection.js";

// ── Types & formatting helpers (public API surface) ─────────────────────────

export type {
  RenderableState,
  RenderableCompoundQueue,
} from "./display-helpers/index.js";
export {
  FRIENDLY_NAMES,
  FRIENDLY_NAMES_BY_TYPE,
  SENSITIVE_FIELDS,
  resolveFieldLabel,
  resolveSetKey,
  spacePascalCase,
  formatValue,
  formatSpecialValue,
  formatDesiredState,
} from "./display-helpers/index.js";
