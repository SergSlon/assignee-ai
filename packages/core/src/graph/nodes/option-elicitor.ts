/**
 * option_elicitor node — interactively collects resource configuration from
 * the user before plan generation, using the ResourcePlugin field definitions
 * from Story 7.1.
 *
 * Live pricing: fetches real-time on-demand prices from the AWS Pricing API
 * MCP server before the prompt loop and injects them into enum option labels.
 *
 * Config integration: loads user config, project config, and org policy in
 * parallel, then uses mergeConfigs() to resolve field values/policies via
 * 6-level precedence. Fields resolved as never_ask are injected silently;
 * ask_if_not_set pre-fills initialValue; always_ask forces a prompt regardless
 * of config.
 *
 * Wave-6c F3: SOLID refactor. Thin façade over SRP sub-modules in
 * `./option-elicitor/`. All previously-exported helpers remain re-exported
 * here (they now live in `utils/wizard-helpers`) for back-compat.
 *
 * @see Story 7.3, Story 27.4
 */

// ── Re-export helpers for backward compatibility ──────────────────────────────

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
} from "../../utils/wizard-helpers.js";

export { resolveFieldConfigs } from "../../utils/field-resolver.js";

export { optionElicitorNode } from "./option-elicitor/orchestrator.js";
