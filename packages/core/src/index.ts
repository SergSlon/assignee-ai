// Top-level barrel for @assignee/core.
// Split into domain-oriented sub-barrels under ./barrels/ for maintainability
// (SRP: each sub-barrel owns one domain; OCP: new exports go into the
// matching domain barrel without touching this file).
export * from "./barrels/schemas.js";
export * from "./barrels/config.js";
export * from "./barrels/types.js";
export * from "./barrels/plugins-patterns.js";
export * from "./barrels/utils.js";
export * from "./barrels/pricing.js";
export * from "./barrels/errors.js";
export * from "./barrels/ports-services.js";
export * from "./destroy-strategies/index.js";
export * from "./list-resources/index.js";
export * from "./aws/index.js";

// Story 60-it1-02 (L4-005 MED close): lift previously-narrow sub-path
// exports into the root barrel so apps/ shims can consume via
// `@assignee/core` and the sub-path exports can be deleted from
// packages/core/package.json. The canonical implementations still live
// under their original paths; this block only widens the public surface.
export {
  MCP_PINS,
  type McpServerConfig,
  getMcpServerConfigs,
  getOptionalMcpServerConfigs,
} from "./config/mcp-servers.js";
export {
  createMcpClient,
  getMcpTools,
  getBillingMcpToolsAsync,
  closeMcpClient,
} from "./services/mcp-client.js";
export {
  PLACEHOLDER_AWS_ACCOUNT_IDS,
  ARN_ACCOUNT_REGEX,
} from "./constants/placeholder-accounts.js";
export {
  ARM_EQUIVALENTS,
  SPOT_ELIGIBLE_PREFIXES,
  RDS_LARGE_CLASS_PREFIXES,
  RDS_BUDGET_ALTERNATIVES,
} from "./constants/instance-family-registry.js";
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
} from "./utils/wizard-helpers.js";
export { resolveFieldConfigs } from "./utils/field-resolver.js";
