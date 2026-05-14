// ---------------------------------------------------------------------------
// Environment-tier extractor — recognises "for staging", "for dev",
// "for production" (and variants) in a natural-language intent string.
// ---------------------------------------------------------------------------
//
// Word-boundary guards are mandatory: "stagingZ" must NOT match "staging".
// Returns null when no tier signal is present — callers treat null as
// "unspecified" and keep their current defaults (Variation D invariant).

import { RESOURCE_TYPES } from "@/index.js";
import { CfnKey } from "@/config/cfn-keys.js";
import type { Advisory } from "../intent-types.js";

export type EnvironmentTier = "staging" | "dev" | "production";

/**
 * Extracts an environment tier hint from the intent string.
 *
 * Matches are word-boundary anchored so "stagingZ" or "productionenv"
 * do NOT trigger a match (Variation F).
 *
 * Returns null when no recognised tier phrase is found.
 */
export function extractEnvironmentTier(intent: string): EnvironmentTier | null {
  const lower = intent.toLowerCase();

  // Staging tier — "for staging", "in staging", standalone "staging"
  if (/\bstaging\b/.test(lower)) return "staging";

  // Dev tier — "for dev", "in development", "for development", "in dev"
  if (/\b(dev|development)\b/.test(lower)) return "dev";

  // Production tier — "for production", "in production", "for prod", "in prod"
  if (/\b(production|prod)\b/.test(lower)) return "production";

  return null;
}

/**
 * Applies environment-tier defaults for RDS DBInstance.
 *
 * Called from extractAssertedValues when resourceType is RDS_DB_INSTANCE.
 * Only writes keys that are NOT already set in elicited (explicit user
 * assertions take priority — Variation E invariant).
 *
 * Staging/dev: MultiAZ=false, DeletionProtection=false,
 *              BackupRetentionPeriod=1, PerformanceInsightsEnabled=false.
 * Production:  MultiAZ=true, DeletionProtection=true,
 *              BackupRetentionPeriod=7, PerformanceInsightsEnabled=true.
 * Null (unspecified): no-op — current plugin defaults remain.
 */
export function applyRdsTierDefaults(
  intent: string,
  resourceType: string,
  elicited: Record<string, unknown>,
  advisories: Advisory[],
): void {
  if (resourceType !== RESOURCE_TYPES.RDS_DB_INSTANCE) return;

  // Detect explicit "with MultiAZ" keyword so it overrides the tier default
  // (Variation E). Must run before tier defaults are applied.
  const lower = intent.toLowerCase();
  if (
    /\bwith\s+multi[\s-]?az\b/.test(lower) ||
    /\bmulti[\s-]?az\s+enabled\b/.test(lower)
  ) {
    if (elicited[CfnKey.MULTI_AZ] === undefined) {
      elicited[CfnKey.MULTI_AZ] = true;
    }
  }

  const tier = extractEnvironmentTier(intent);
  if (tier === null) return;

  const isStagingLike = tier === "staging" || tier === "dev";
  const tierDefaults: Record<string, unknown> = isStagingLike
    ? {
        [CfnKey.MULTI_AZ]: false,
        [CfnKey.DELETION_PROTECTION]: false,
        [CfnKey.BACKUP_RETENTION_PERIOD]: 1,
        [CfnKey.PERFORMANCE_INSIGHTS]: false,
      }
    : {
        [CfnKey.MULTI_AZ]: true,
        [CfnKey.DELETION_PROTECTION]: true,
        [CfnKey.BACKUP_RETENTION_PERIOD]: 7,
        [CfnKey.PERFORMANCE_INSIGHTS]: true,
      };

  for (const [key, value] of Object.entries(tierDefaults)) {
    if (elicited[key] === undefined) {
      elicited[key] = value;
    }
  }

  advisories.push({
    code: "RDS_ENVIRONMENT_TIER_DEFAULTS",
    message: `Detected '${tier}' environment — applied ${tier}-appropriate defaults; override with --set MultiAZ=true if needed.`,
    hint: `For ${tier} environments, MultiAZ, DeletionProtection, BackupRetentionPeriod and PerformanceInsightsEnabled are set to cost-appropriate values.`,
  });
}
