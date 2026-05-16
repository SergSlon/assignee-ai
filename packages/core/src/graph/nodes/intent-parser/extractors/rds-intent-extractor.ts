// ---------------------------------------------------------------------------
// rds-intent-extractor.ts — RDS-specific VPC security group advisory.
// ---------------------------------------------------------------------------
//
// DF-E2 fix (dogfood 2026-05-11): `assignee plan "rds postgres"` emitted an
// empty `VPCSecurityGroups: []` in the plan output. The skeletal-plan-detector
// already flags this as `isSkeletal=true`, but the user sees it only AFTER
// the plan is generated — at which point the apply path is already marked
// unsafe. A proactive advisory at extraction time gives the user the explicit
// elicitation prompt BEFORE the plan is finalised, matching the existing
// `applyRdsTierDefaults` advisory pattern.
//
// Two scenarios:
//
//   (a) No VPCSecurityGroups in the intent at all → advisory prompts the user
//       to provide one via `--set VPCSecurityGroups=<sg-id>`. The plan is still
//       generated (advisories are non-blocking) but the result-formatter will
//       surface the skeletal-plan warning. This advisory makes the ask explicit
//       at extraction time — earlier, more actionable, consistent with the
//       "elicitation advisory" pattern used by name/tier extractors.
//
//   (b) Explicit sg-XXXX IDs in the intent → extract and write to elicited;
//       no advisory needed.
//
// The extractor is intentionally conservative: it only runs for
// RESOURCE_TYPES.RDS_DB_INSTANCE. Compound patterns (rds-with-vpc,
// three-tier-web) auto-wire the SG via `companionResources` in
// rds-dbinstance/config.ts — those compound paths produce non-empty
// VPCSecurityGroups before this point, so no false-positive advisory fires.
//
// Non-RDS resource types are unaffected (function is a no-op for them).
//
// Story 108-A-02 — DF-E2

import { RESOURCE_TYPES } from "@/index.js";
import { CfnKey } from "@/config/cfn-keys.js";
import type { Advisory } from "../intent-types.js";

/**
 * Regex for extracting explicit `sg-XXXX` security group ID tokens from
 * the intent. AWS SG IDs come in two shapes:
 *   - 8-char legacy (`sg-12345678`)
 *   - 17-char modern (`sg-0a1b2c3d4e5f67890`)
 *
 * The regex is intentionally conservative — only word-boundary anchored
 * so it won't match substrings of larger tokens.
 */
const SG_ID_REGEX = /\bsg-(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{17})\b/g;

/**
 * Check whether the intent already contains an explicit security-group ID
 * assertion (`sg-...`). When present, the user is explicitly providing a SG
 * and we extract it rather than emitting an advisory.
 */
function extractSgIdsFromIntent(intent: string): string[] {
  const matches = intent.match(SG_ID_REGEX);
  return matches ?? [];
}

/**
 * Applies RDS-specific VPC security group extraction to the assertion
 * extraction pipeline.
 *
 * Called from `extractAssertedValues` in `index.ts` as part of the
 * standard extractor chain. Runs AFTER the generic SG-ingress extractor
 * so that network-level SG rules don't interfere.
 *
 * Behaviour:
 *   - No-op for non-RDS resource types.
 *   - If `elicited[VPC_SECURITY_GROUP_IDS]` is already set (set by an
 *     earlier extractor or by user preset), no-op — explicit value wins.
 *   - If explicit `sg-XXXX` IDs appear in the intent → extract them into
 *     `elicited[VPC_SECURITY_GROUP_IDS]`.
 *   - Otherwise → push an elicitation advisory telling the user to supply
 *     a security group or route through the compound pattern.
 */
export function extractRdsVpcSecurityGroups(
  intent: string,
  resourceType: string,
  elicited: Record<string, unknown>,
  advisories: Advisory[],
): void {
  // Only applies to standalone RDS DB instances.
  if (resourceType !== RESOURCE_TYPES.RDS_DB_INSTANCE) return;

  // If VPCSecurityGroups is already set (e.g. via --set or earlier extractor),
  // respect the user's explicit value and do nothing.
  const existing = elicited[CfnKey.VPC_SECURITY_GROUP_IDS];
  if (
    existing !== undefined &&
    existing !== null &&
    Array.isArray(existing) &&
    (existing as unknown[]).length > 0
  ) {
    return;
  }

  // Attempt to extract explicit `sg-XXXX` IDs from the natural-language
  // intent. If the user said "with security group sg-0a1b2c3d4e5f67890",
  // extract it and write it.
  const sgIds = extractSgIdsFromIntent(intent);
  if (sgIds.length > 0) {
    elicited[CfnKey.VPC_SECURITY_GROUP_IDS] = sgIds;
    return;
  }

  // No SG specified: push an elicitation advisory. The plan will be generated
  // with empty VPCSecurityGroups (which the skeletal-plan-detector will flag),
  // AND the user sees this advisory immediately with the actionable fix.
  advisories.push({
    code: "RDS_VPC_SECURITY_GROUPS_EMPTY",
    message:
      "No VPC security groups specified for RDS. The plan will fail at apply time unless a security group is provided.",
    hint:
      "Add a security group that allows ingress on the DB port via " +
      "`--set VPCSecurityGroups=<sg-id>` (e.g. `--set VPCSecurityGroups=sg-0a1b2c3d4e5f67890`), " +
      "or route through the `rds-with-vpc` compound pattern which creates an engine-aware security group automatically " +
      '(e.g. `assignee plan "Create RDS Postgres with VPC"`). ' +
      "Alternatively, list your existing security groups with " +
      "`aws ec2 describe-security-groups --query 'SecurityGroups[].GroupId'`.",
  });
}
