/**
 * Re-export barrel for the bulk-destroy pipeline.
 *
 * The implementation was split into `./bulk-destroy/` during Wave 6e F3
 * to enforce the 300-LOC/file rule. External callers and tests continue
 * to import from `../services/bulk-destroy.js` — this file is kept as
 * a thin facade over the new module tree.
 *
 * @see ./bulk-destroy/index.ts
 * @see Story 36.2
 */

export type {
  ManagedResource,
  BulkDestroyPlan,
  BulkDestroyOptions,
} from "./bulk-destroy/index.js";
export {
  DESTROY_TIER,
  CCAPI_TYPE_PATTERN,
  isAssigneeInfraResource,
  buildPlanFromResources,
  planBulkDestroy,
} from "./bulk-destroy/index.js";
