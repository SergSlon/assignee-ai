/**
 * Thin re-export shim — canonical implementation lives in
 * `@assignee/core/graph/nodes/option-elicitor.js`
 * (Story 50-4 Wave 5 Pass H).
 */
export { optionElicitorNode } from "@assignee/core/graph/nodes/option-elicitor.js";

// Back-compat re-exports — downstream code still imports wizard-helpers names
// from "./option-elicitor.js" (see pre-lift history). These now resolve through
// core's wizard-helpers barrel.
export {
  fieldFetchKey,
  evaluateShowIf,
  populateDefaultOptions,
  enrichFieldLabels,
  applyCategorySmartFilter,
  applyOptionRanking,
  getDiscoverySpinnerMessage,
  resolveDynamicFields,
  fetchPricesForResource,
  injectPriceLabels,
  enrichWithLivePricing,
  mergeEnrichedFields,
  injectBPHints,
  fetchSuggestionPrice,
  promptWithHelp,
} from "@assignee/core/utils/wizard-helpers.js";
export { resolveFieldConfigs } from "@assignee/core/utils/field-resolver.js";
