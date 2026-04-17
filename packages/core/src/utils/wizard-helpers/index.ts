/**
 * Barrel re-exports for the wizard-helpers SOLID decomposition.
 *
 * Wave-6b F4: split the original 1089-LOC `wizard-helpers.ts` into per-concern
 * modules. The legacy entrypoint (`../wizard-helpers.ts`) re-exports from this
 * barrel for back-compat — every existing importer continues to resolve.
 */

export { fieldFetchKey, evaluateShowIf } from "./show-if.js";
export { populateDefaultOptions } from "./defaults.js";
export {
  enrichFieldLabels,
  applyCategorySmartFilter,
  applyOptionRanking,
} from "./labels.js";
export {
  getDiscoverySpinnerMessage,
  resolveDynamicFields,
} from "./discovery.js";
export {
  fetchPricesForResource,
  injectPriceLabels,
  enrichWithLivePricing,
  mergeEnrichedFields,
  fetchSuggestionPrice,
} from "./pricing-hints.js";
export { injectBPHints } from "./bp-hints.js";
export { promptWithHelp } from "./prompt-dispatcher.js";
