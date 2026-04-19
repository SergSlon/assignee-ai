/**
 * Free tier awareness for the MCP server's estimate_cost tool.
 *
 * Shape-adapter over the single source of truth in
 * `@assignee/core` → `getFreeTierMaps()`. The MCP tool response uses a
 * slightly different shape and message wording than the CLI preflight
 * (see {@link FreeTierInfo}) so this module reshapes the core maps rather
 * than re-exporting `getFreeTierNote` directly.
 *
 * Previously this file duplicated the three resource→message maps inline
 * (67 LOC). Any new always-free / usage-limited / legacy-eligible resource
 * added to core would have drifted here. The adapter below closes that gap
 * (Story 58-it1-01, L4-004).
 *
 * @see Story 7.8, Story 20.4, Story 58-it1-01
 */

import { getFreeTierMaps } from "@assignee/core";

/** Free tier info returned by getFreeTierNote. */
export interface FreeTierInfo {
  type: "always_free" | "usage_limited" | "legacy_eligible";
  message: string;
}

/**
 * Derives an AWS service name from a CloudFormation resource type so the
 * MCP tool response can surface a human-readable label (e.g., "Lambda",
 * "SQS") that MCP clients historically match on.
 *
 * `AWS::Lambda::Function` → `Lambda`, `AWS::SQS::Queue` → `SQS`.
 * Falls back to the full type for unexpected shapes.
 */
function serviceLabelFor(resourceType: string): string {
  const parts = resourceType.split("::");
  return parts.length >= 2 ? parts[1]! : resourceType;
}

/**
 * Returns free tier information for a resource type, or null if not applicable.
 *
 * Shape mapping from core → MCP:
 * - core `alwaysFree`            → `{ type: "always_free", message: <core msg> }`
 * - core `alwaysFreeWithLimits`  → `{ type: "usage_limited", message: "AWS <Service> free tier: <core msg>" }`
 * - core `legacyEligible`        → `{ type: "legacy_eligible", message: "May be free tier eligible (<core msg> — depends on account age)" }`
 *
 * The `usage_limited` message format intentionally embeds the AWS service
 * label (Lambda / SQS / SNS / DynamoDB) — MCP tool responses have shipped
 * with that wording since Story 20.4 and downstream consumers match on it.
 * Lowercase "free tier" is preserved so existing substring checks like
 * `.toContain("free")` in caller tests keep passing.
 *
 * Unlike the CLI helper, this adapter does not consult the
 * `aws_account_created` config — the MCP tool is stateless and reports
 * eligibility at the category level, leaving account-age reasoning to the
 * caller.
 */
export function getFreeTierNote(resourceType: string): FreeTierInfo | null {
  const { alwaysFree, alwaysFreeWithLimits, legacyEligible } =
    getFreeTierMaps();

  const alwaysFreeMsg = alwaysFree[resourceType];
  if (alwaysFreeMsg) {
    return { type: "always_free", message: alwaysFreeMsg };
  }

  const usageLimitedMsg = alwaysFreeWithLimits[resourceType];
  if (usageLimitedMsg) {
    const service = serviceLabelFor(resourceType);
    return {
      type: "usage_limited",
      message: `AWS ${service} free tier: ${usageLimitedMsg}`,
    };
  }

  const legacyMsg = legacyEligible[resourceType];
  if (legacyMsg) {
    return {
      type: "legacy_eligible",
      message: `May be free tier eligible (${legacyMsg} — depends on account age)`,
    };
  }

  return null;
}
