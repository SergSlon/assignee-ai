/**
 * Wizard helpers — back-compat facade.
 *
 * Wave-6b F4 SOLID refactor: the original 1089-LOC monolith was split into
 * per-concern modules under `./wizard-helpers/`:
 *
 *   - show-if.ts          — `fieldFetchKey`, `evaluateShowIf`
 *   - defaults.ts         — `populateDefaultOptions` (two-pass fixpoint)
 *   - labels.ts           — `enrichFieldLabels`, `applyCategorySmartFilter`,
 *                           `applyOptionRanking`
 *   - discovery.ts        — `getDiscoverySpinnerMessage`,
 *                           `resolveDynamicFields` (+ fetcherMap)
 *   - pricing-hints.ts    — `fetchPricesForResource`, `injectPriceLabels`,
 *                           `enrichWithLivePricing`, `mergeEnrichedFields`,
 *                           `fetchSuggestionPrice`
 *   - bp-hints.ts         — `injectBPHints` (NON-MUTATING — invariant)
 *   - prompt-dispatcher.ts — `promptWithHelp` (?-help loop + Other affordance)
 *   - index.ts            — barrel
 *
 * This file re-exports the same public API, so every existing import path
 * (`from "../utils/wizard-helpers.js"`) continues to resolve unchanged.
 *
 * @see option-elicitor.ts for the main wizard loop that consumes these helpers.
 */

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
  fetchSuggestionPrice,
  injectBPHints,
  promptWithHelp,
} from "./wizard-helpers/index.js";
