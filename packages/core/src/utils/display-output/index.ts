/**
 * Barrel for display-output/ sub-modules.
 * Entrypoint: re-exports every renderer + spinner control under the same
 * surface as the old display-output.ts file, so the parent display.ts
 * barrel and any other callers keep working without touching imports.
 */
export { startSpinner, updateSpinner, stopSpinner } from "./spinner.js";
export { renderIntro, renderOutro } from "./intro-outro.js";
export { renderError } from "./error.js";
export { renderApplySuccess } from "./apply-success.js";
export { renderCompoundSuccess } from "./compound-success.js";
export { renderCompoundPartialFailure } from "./compound-failure.js";
export { renderSecurityWarnings } from "./security-warnings.js";
export { renderDependencyPlan } from "./dependency-plan.js";
export { renderResourceTable, renderEmptyList } from "./resource-table.js";
export { renderStatusSummary, renderEmptyStatus } from "./status-summary.js";
