/**
 * Thin re-export shim — canonical implementations live in
 * `@assignee/core/utils/display-output` (Story 50-4 Wave 5 Pass C-2).
 */
export {
  startSpinner,
  updateSpinner,
  stopSpinner,
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
} from "@assignee/core";
