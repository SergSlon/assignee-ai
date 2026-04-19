/**
 * Free Tier awareness utility for the preflight cost display.
 * Detects whether a resource type qualifies for AWS Free Tier and surfaces
 * an informational note in the plan box output.
 *
 * Non-blocking by design (AC #6): this module never throws. If detection
 * fails, callers receive `null` and continue without a note.
 *
 * Architecture:
 * - Data maps live in `./free-tier/maps.ts` (Story 60-it1-01, L7-001).
 * - {@link getFreeTierNote} — pure classifier over those maps.
 * - {@link getFreeTierNoteWithConfig} — IO entry that reads the YAML
 *   config for `aws_account_created` then delegates to the classifier.
 *
 * @see Story 7.8 — FR-17 Free Tier Awareness
 * @see Story 58-it1-01 — pure/IO split (L4-004)
 * @see Story 60-it1-01 — data-layer extraction (L7-001)
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ASSIGNEE_DIR } from "../config/cfn-keys.js";
import { FileName } from "../config/constants/paths.js";
import { CostEstimateLabel } from "../pricing/filter-constants.js";
import {
  FreeTierType,
  getFreeTierMaps,
  type FreeTierNote,
} from "./free-tier/maps.js";

// Preserve public API: re-export data-layer symbols so existing consumers
// (`import { … } from "./free-tier.js"`) keep resolving post-extraction.
export {
  FreeTierType,
  FREE_TIER_MESSAGE,
  getFreeTierMaps,
  type FreeTierTypeValue,
  type FreeTierNote,
  type FreeTierMaps,
} from "./free-tier/maps.js";

/** Module-level cache. `null` = not yet loaded; `undefined` = missing/invalid. */
let cachedAccountDate: string | undefined | null = null;

/**
 * Reads `aws_account_created` from `~/.assignee/config.yaml` (cached).
 * NEVER throws — returns `undefined` on any error.
 */
export function loadAccountCreatedDate(): string | undefined {
  if (cachedAccountDate !== null) return cachedAccountDate;
  try {
    const configPath = join(homedir(), ASSIGNEE_DIR, FileName.CONFIG);
    const content = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown> | undefined;
    const dateValue = parsed?.["aws_account_created"];
    cachedAccountDate = typeof dateValue === "string" ? dateValue : undefined;
  } catch {
    cachedAccountDate = undefined;
  }
  return cachedAccountDate;
}

/** @internal Resets the cached account date. Testing only. */
export function _resetAccountDateCache(): void {
  cachedAccountDate = null;
}

/**
 * Returns a free tier eligibility note for the given resource type, or
 * `null` if the resource is not covered by any known category.
 */
export function getFreeTierNote(
  resourceType: string,
  accountCreatedDate?: string,
): FreeTierNote | null {
  const { alwaysFree, alwaysFreeWithLimits, legacyEligible, cutoffDate } =
    getFreeTierMaps();

  const alwaysFreeMsg = alwaysFree[resourceType];
  if (alwaysFreeMsg) {
    return { type: FreeTierType.ALWAYS_FREE, message: alwaysFreeMsg };
  }

  const alwaysFreeLimitMsg = alwaysFreeWithLimits[resourceType];
  if (alwaysFreeLimitMsg) {
    return { type: FreeTierType.ALWAYS_FREE, message: alwaysFreeLimitMsg };
  }

  const legacyMsg = legacyEligible[resourceType];
  if (legacyMsg) {
    if (accountCreatedDate === undefined) {
      return {
        type: FreeTierType.CREDITS_APPLY,
        message:
          "Free tier eligibility unknown -- check your AWS billing dashboard",
      };
    }
    if (accountCreatedDate >= cutoffDate) {
      return {
        type: FreeTierType.CREDITS_APPLY,
        message: "AWS credits may apply -- check your billing dashboard",
      };
    }
    if (isWithin12Months(accountCreatedDate)) {
      return {
        type: FreeTierType.LEGACY_ELIGIBLE,
        message: `Free tier: ${legacyMsg} remaining`,
      };
    }
    return null; // Legacy account but 12-month window expired.
  }

  return null;
}

/**
 * IO entry: reads the YAML config (cached) then delegates to the pure
 * {@link getFreeTierNote} classifier. NEVER throws.
 */
export function getFreeTierNoteWithConfig(
  resourceType: string,
): FreeTierNote | null {
  return getFreeTierNote(resourceType, loadAccountCreatedDate());
}

/** Whether `dateStr` is within 12 months from today. Day-level granularity. */
function isWithin12Months(dateStr: string): boolean {
  const created = new Date(dateStr);
  if (isNaN(created.getTime())) return false;
  const now = new Date();
  const twelveMonthsAgo = new Date(
    now.getFullYear() - 1,
    now.getMonth(),
    now.getDate(),
  );
  return created >= twelveMonthsAgo;
}

/**
 * Returns "Free" for always-free resource types, or null if cost is unknown.
 * Used by the list command as a fallback when the provision log has no cost.
 */
export function getFreeTierCostLabel(resourceType: string): string | null {
  if (getFreeTierMaps().alwaysFree[resourceType]) {
    return CostEstimateLabel.FREE;
  }
  return null;
}
