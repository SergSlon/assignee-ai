/**
 * Public barrel for the bulk-destroy pipeline. Consumers should keep
 * importing from `../services/bulk-destroy.js`, which re-exports
 * everything here.
 *
 * @see Story 36.2
 */

export type {
  ManagedResource,
  BulkDestroyPlan,
  BulkDestroyOptions,
} from "./types.js";
export { DESTROY_TIER, CCAPI_TYPE_PATTERN } from "./tiers.js";
export { isAssigneeInfraResource } from "./safety-allowlist.js";
export { buildPlanFromResources } from "./plan-builder.js";
export { planBulkDestroy } from "./orchestrator.js";
