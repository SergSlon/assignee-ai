/**
 * Barrel for the cost-estimator subsystem. Preserves the public API
 * previously exported from services/cost-estimator.ts so callers can
 * continue to `import { … } from "../services/cost-estimator.js"`
 * via the re-export shim.
 *
 * @see Story 20.4
 */

export { classifyResourceType } from "./classifier.js";
export { estimateCostForResource } from "./estimator.js";
export type { CostEstimateResult } from "./types.js";
