/**
 * BP rule loader with freshness warning.
 *
 * Story 50-3: the strict-mode/GPG integrity enforcement layer was removed
 * (supply-chain theatre — bumping a signing key is an out-of-band concern).
 * What remains is the same SHA-256 manifest computation used by the release
 * tooling, plus a freshness warning when the BP library mtime is older than
 * 180 days. Rule loading itself is cached after the first call; no
 * integrity gate stands between the caller and loadBestPractices().
 *
 * Wave-6c F3: extracted from bp-evaluator.ts (SRP).
 */

import {
  loadBestPractices,
  computeFreshness,
  type BestPractice,
} from "@assignee/best-practices";
import { log, LOG_ACTIONS } from "../../utils/logger.js";

let cachedPractices: BestPractice[] | undefined;
let freshnessChecked = false;

/** Loads BP rules, caches after the first load. */
export function loadCached(): BestPractice[] {
  if (cachedPractices !== undefined) {
    return cachedPractices;
  }

  const loaded = loadBestPractices();

  // Emit a single stderr warning if the library is stale; never blocks.
  if (!freshnessChecked) {
    freshnessChecked = true;
    try {
      const freshness = computeFreshness();
      if (freshness.isStale) {
        process.stderr.write(
          `⚠  Best-practice rules are stale (oldest file is ${freshness.oldestAgeDays} days old, threshold is ${freshness.staleThresholdDays}). ` +
            `Consider updating assignee-ai.\n`,
        );
      }
    } catch (err) {
      log({
        ts: new Date().toISOString(),
        runId: "system",
        level: "warn",
        action: LOG_ACTIONS.BP_EVALUATION_SKIPPED,
        extras: { phase: "freshness_check", error: String(err) },
      });
    }
  }

  cachedPractices = loaded;
  return cachedPractices;
}

/** Resets the cached practices. Intended for testing only. */
export function resetBPCache(): void {
  cachedPractices = undefined;
  freshnessChecked = false;
}
