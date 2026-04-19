/**
 * ARN display resolution.
 *
 * See feedback_arn_builder_for_display: synthesize a full ARN from bare
 * CCAPI identifiers so display / log / provision-record / security posture
 * all show a consistent value. The DISPLAY ARN is used for logging, billing
 * lookups, and SecurityHub queries — all of which require full ARNs.
 *
 * IMPORTANT: do NOT unconditionally mutate state.resourceArn for compound
 * provisioning — the compound marker resolver in plan-generator substitutes
 * `match.resourceArn` verbatim into child fields like VpcId, SubnetId, which
 * require BARE identifiers (see the v6 P0 fix documented in result-formatter).
 *
 * The helper here returns the resolved ARN; callers decide when to propagate
 * it to the graph state.
 */

import type { ResourceResult } from "@/index.js";
import { resolveResourceArn } from "@/utils/resolve-arn.js";

/**
 * Resolve a (resourceType, identifier) pair to a full ARN for display.
 * Falls back to the bare identifier if resolution fails or no type is known.
 */
export async function resolveDisplayArn(
  resourceType: string | undefined,
  identifier: string | undefined,
): Promise<string | undefined> {
  if (!identifier) return identifier;
  if (!resourceType) return identifier;
  return (await resolveResourceArn({ resourceType, identifier })) ?? identifier;
}

/**
 * Build a displayArns map keyed by resourceId for a completed compound.
 * Used to feed renderCompoundSuccess / provision record / security posture
 * with full ARNs while the graph-state completedResources[].resourceArn
 * retains the bare identifier that drift/reconcile paths expect.
 */
export async function buildDisplayArnMap(
  completed: readonly ResourceResult[],
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const entry of completed) {
    if (entry.resourceId && entry.resourceArn) {
      const resolved =
        (await resolveResourceArn({
          resourceType: entry.resourceType,
          identifier: entry.resourceArn,
        })) ?? entry.resourceArn;
      map[entry.resourceId] = resolved;
    }
  }
  return map;
}
