/**
 * Pure plan builder — takes fetched resources and produces a
 * BulkDestroyPlan by filtering, classifying, and ordering them by tier.
 *
 * No AWS SDK calls — those live in `orchestrator.ts` which wraps this
 * builder. Keeping the filter/sort pipeline pure makes it cheap to unit
 * test against hand-rolled fetched-resource lists.
 *
 * @see Story 36.2
 */

import { log, LOG_ACTIONS } from "../../utils/logger.js";
import {
  CCAPI_TYPE_PATTERN,
  DESTROY_TIER,
  DEFAULT_TIER,
  isIamType,
} from "./tiers.js";
import { isAssigneeInfraResource } from "./safety-allowlist.js";
import { extractIdentifier } from "./identifier.js";
import type {
  BulkDestroyOptions,
  BulkDestroyPlan,
  ManagedResource,
} from "./types.js";

/**
 * Pure plan builder — takes already-fetched resources and produces a
 * BulkDestroyPlan. Exported for unit testing without AWS calls.
 */
export function buildPlanFromResources(
  fetchedResources: Array<{
    arn: string;
    resourceType: string;
    region: string;
  }>,
  options?: BulkDestroyOptions,
): BulkDestroyPlan {
  const includeIam = options?.includeIam ?? false;
  const pattern = options?.pattern;
  const regionFilter = options?.region;

  let iamCount = 0;
  let excludedCount = 0;
  const resources: ManagedResource[] = [];

  for (const fetched of fetchedResources) {
    const { arn, resourceType, region } = fetched;

    // RGTA returns non-CCAPI resource types like "AWS::Backup::Recovery-point"
    // (lowercase hyphen) that fail CloudControl's typeName regex. Filter them
    // out before they reach destroySingleResource and produce noisy errors.
    // Log at INFO (architect WARNING #5) so users can see why a given
    // resource was skipped rather than wondering why it survived destroy.
    if (!CCAPI_TYPE_PATTERN.test(resourceType)) {
      excludedCount++;
      log({
        ts: new Date().toISOString(),
        runId: "bulk-destroy",
        level: "info",
        action: LOG_ACTIONS.CCAPI_TYPE_DROPPED,
        extras: { arn, resourceType, region },
      });
      continue;
    }

    const identifier = extractIdentifier(arn);
    const tier = DESTROY_TIER[resourceType] ?? DEFAULT_TIER;
    const iam = isIamType(resourceType);

    if (iam) {
      iamCount++;
    }

    // Safety allowlist: never destroy assignee.ai's own setup-created
    // operator infrastructure, even when --include-iam is set. These
    // resources (AssigneeOperatorPolicy, AssigneeReaderPolicy, etc.)
    // are created by `assignee setup` and removing them locks the
    // user out of their own AWS account.
    if (isAssigneeInfraResource(arn)) {
      excludedCount++;
      continue;
    }

    // Filter: IAM exclusion (unless opted-in)
    if (iam && !includeIam) {
      excludedCount++;
      continue;
    }

    // Filter: region. IAM is a global service — its resources carry
    // region="global" in the inventory, which would otherwise be
    // filtered out by any region scope. Skip the region check for
    // global resources so `destroy --all --include-iam` actually
    // includes user IAM roles regardless of operator region.
    const isGlobalService = region === "global";
    if (regionFilter && !isGlobalService && region !== regionFilter) {
      excludedCount++;
      continue;
    }

    // Filter: pattern (match against ARN or identifier)
    if (pattern && !pattern.test(arn) && !pattern.test(identifier)) {
      excludedCount++;
      continue;
    }

    resources.push({ arn, resourceType, identifier, region, tier });
  }

  // Sort by tier ascending — tier 1 destroyed first, tier 6 last
  resources.sort((a, b) => a.tier - b.tier);

  return {
    resources,
    totalCount: fetchedResources.length,
    iamCount,
    excludedCount,
  };
}
