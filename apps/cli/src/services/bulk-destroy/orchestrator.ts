/**
 * BulkDestroy orchestrator — wraps the pure plan builder with the
 * AWS Resource Groups Tagging API fetch step.
 *
 * Keeping the fetch concern here (instead of in plan-builder) preserves
 * the `buildPlanFromResources` unit test surface: tests hand in a list,
 * production code fetches it first.
 *
 * @see Story 36.2
 */

import { fetchManagedResources } from "../list-resources.js";
import { buildPlanFromResources } from "./plan-builder.js";
import type { BulkDestroyOptions, BulkDestroyPlan } from "./types.js";

/**
 * Builds a bulk destruction plan by listing all managed resources,
 * classifying them by type and dependency tier, and ordering them
 * for safe destruction (dependents before foundations).
 *
 * @param options - Filtering and control options
 * @returns A BulkDestroyPlan with ordered resources and summary counts
 */
export async function planBulkDestroy(
  options?: BulkDestroyOptions,
): Promise<BulkDestroyPlan> {
  let fetchedResources;
  try {
    fetchedResources = await fetchManagedResources(options?.region);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to list managed resources. Check your AWS credentials and network connection. Details: ${message}`,
    );
  }

  return buildPlanFromResources(fetchedResources, options);
}
