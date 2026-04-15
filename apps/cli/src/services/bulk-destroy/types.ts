/**
 * Shared types for the bulk-destroy pipeline.
 *
 * @see Story 36.2
 */

/** A managed resource enriched with destruction-ordering metadata. */
export interface ManagedResource {
  arn: string;
  resourceType: string;
  identifier: string;
  region: string;
  tier: number; // destruction order tier (1=first, 6=last)
}

/** The result of planning a bulk destroy operation. */
export interface BulkDestroyPlan {
  resources: ManagedResource[]; // ordered by tier ascending (destroy order)
  totalCount: number;
  iamCount: number; // how many are IAM (excluded by default)
  excludedCount: number; // how many filtered out
}

/** Options for filtering and controlling the bulk destroy plan. */
export interface BulkDestroyOptions {
  includeIam?: boolean; // include IAM policies/roles (default: false)
  pattern?: RegExp; // filter by identifier pattern (for clean --resources)
  region?: string; // filter by region
}
