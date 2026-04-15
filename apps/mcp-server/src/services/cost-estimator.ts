/**
 * Lightweight cost estimation service for the estimate_cost MCP tool.
 *
 * This module is now a thin re-export shim over the cost-estimator/
 * subdirectory (Wave-6e F2 refactor). Splitting it keeps each module
 * under the 300 LOC SRP budget while preserving the `../services/
 * cost-estimator.js` import path that callers and tests rely on.
 *
 * @see services/cost-estimator/index.ts
 */

export {
  classifyResourceType,
  estimateCostForResource,
  type CostEstimateResult,
} from "./cost-estimator/index.js";
