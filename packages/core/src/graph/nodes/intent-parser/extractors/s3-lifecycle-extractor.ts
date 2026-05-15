/**
 * S3 lifecycle intent extractor.
 *
 * Detects bare "lifecycle Nd" / "lifecycle N days" phrases in the user
 * intent and classifies them as expire-only (no IA transition). When the
 * user explicitly mentions both "transition" and "expire" (or supplies a
 * full ladder like "transition to IA after Nd then expire after Md"), the
 * full multi-rule lifecycle is preserved instead.
 *
 * PD-4 / PH1-E-1 fix — resolves the contradiction where "lifecycle 30d"
 * emitted both an IA transition AND a 30-day expiration at the same
 * boundary, making the transition pointless.
 *
 * PH5-8-A extension — detects "old versions" / "noncurrent" / "previous
 * versions" combined with "after N days" and sets
 * LifecycleNoncurrentExpirationDays=N. When versioning is not mentioned in
 * the intent, emits S3_NONCURRENT_REQUIRES_VERSIONING advisory.
 *
 * Populated fields in `elicited`:
 *   - `EnableLifecycle`                     = true
 *   - `LifecycleExpireOnly`                 = true  (bare expire-only path)
 *   - `LifecycleExpirationDays`             = N     (current-version expiry days)
 *   - `LifecycleNoncurrentExpirationDays`   = N     (noncurrent-version expiry days)
 *
 * Advisory emitted (bare path only):
 *   code:    "S3_LIFECYCLE_SIMPLIFIED"
 *   message: "Lifecycle simplified to expire-after-<N>d."
 *   hint:    "Use 'transition to IA after Nd then expire after Md' for a multi-tier ladder."
 *
 * Advisory emitted (noncurrent without versioning):
 *   code:    "S3_NONCURRENT_REQUIRES_VERSIONING"
 *   message: "NoncurrentVersionExpiration requires versioning to be enabled."
 *   hint:    "Add 'versioning enabled' to your intent or enable VersioningConfiguration manually."
 */

import { RESOURCE_TYPES } from "@/index.js";
import type { Advisory } from "../intent-types.js";

export const S3_LIFECYCLE_SIMPLIFIED_CODE = "S3_LIFECYCLE_SIMPLIFIED";
export const S3_LIFECYCLE_SIMPLIFIED_HINT =
  "Use 'transition to IA after Nd then expire after Md' for a multi-tier ladder.";

export const S3_NONCURRENT_REQUIRES_VERSIONING_CODE =
  "S3_NONCURRENT_REQUIRES_VERSIONING";
export const S3_NONCURRENT_REQUIRES_VERSIONING_HINT =
  "Add 'versioning enabled' to your intent or enable VersioningConfiguration manually.";

/**
 * Extracts S3 lifecycle intent from the user's natural-language string.
 *
 * Bare "lifecycle Nd" / "lifecycle N days" → expire-only + advisory.
 * Explicit "transition ... expire" ladder → no extraction (multi-rule
 * path handled by the wizard defaults and assembleS3Composites).
 *
 * Only fires when resourceType is AWS::S3::Bucket.
 */
export function extractS3Lifecycle(
  intent: string,
  intentLower: string,
  resourceType: string,
  elicited: Record<string, unknown>,
  advisories: Advisory[],
): void {
  if (resourceType !== RESOURCE_TYPES.S3_BUCKET) return;

  // Only act when the intent mentions "lifecycle"
  if (!intentLower.includes("lifecycle")) return;

  // If the user explicitly mentions "transition" AND "expire", they want
  // a full multi-rule ladder — leave the lifecycle to the wizard defaults.
  const hasTransition = /\btransition\b/.test(intentLower);
  const hasExpire = /\bexpire[sd]?\b|\bexpir(?:ation|y)\b/.test(intentLower);
  if (hasTransition && hasExpire) return;

  // PH5-8-A: detect noncurrent/old-version lifecycle keywords.
  const hasNoncurrentKeyword =
    /\bold\s+(?:object\s+)?versions?\b/.test(intentLower) ||
    /\bnon-?current(?:\s+versions?)?\b/.test(intentLower) ||
    /\bprevious\s+versions?\b/.test(intentLower);

  // Patterns for extracting a days value from noncurrent phrases:
  //   "delete old versions after 30 days"
  //   "noncurrent after 30d"
  //   "previous versions after 7 days"
  const noncurrentPatterns: RegExp[] = [
    /(?:old\s+(?:object\s+)?versions?|non-?current(?:\s+versions?)?|previous\s+versions?)\s+(?:after\s+)?(\d{1,4})\s*d\b/i,
    /(?:old\s+(?:object\s+)?versions?|non-?current(?:\s+versions?)?|previous\s+versions?)\s+(?:after\s+)?(\d{1,4})\s+days?\b/i,
    /(?:after\s+)?(\d{1,4})\s*d\b.*?(?:old\s+(?:object\s+)?versions?|non-?current(?:\s+versions?)?|previous\s+versions?)/i,
    /(?:after\s+)?(\d{1,4})\s+days?\b.*?(?:old\s+(?:object\s+)?versions?|non-?current(?:\s+versions?)?|previous\s+versions?)/i,
    // "delete old versions after N days" / "lifecycle to delete old versions after N days"
    /delete\s+(?:old\s+(?:object\s+)?versions?|non-?current(?:\s+versions?)?|previous\s+versions?)\s+after\s+(\d{1,4})\s+days?\b/i,
  ];

  let noncurrentDays: number | undefined;
  if (hasNoncurrentKeyword) {
    for (const re of noncurrentPatterns) {
      const m = re.exec(intent);
      if (!m) continue;
      const n = Number(m[1]);
      if (!Number.isFinite(n) || n < 1) continue;
      noncurrentDays = n;
      break;
    }
    // Fallback: use a generic "after N days" / "N days" near lifecycle if no specific pattern matched
    if (noncurrentDays === undefined) {
      const fallbackPatterns: RegExp[] = [
        /after\s+(\d{1,4})\s+days?\b/i,
        /(\d{1,4})\s+days?\b/i,
        /(\d{1,4})\s*d\b/i,
      ];
      for (const re of fallbackPatterns) {
        const m = re.exec(intent);
        if (!m) continue;
        const n = Number(m[1]);
        if (!Number.isFinite(n) || n < 1) continue;
        noncurrentDays = n;
        break;
      }
    }
  }

  // Match bare "lifecycle Nd" / "lifecycle N days" / "lifecycle N-day"
  // The day value is required — we won't fire on "lifecycle rules" alone.
  const currentPatterns: RegExp[] = [
    /\blifecycle\s+(\d{1,4})\s*d\b/i,
    /\blifecycle\s+(\d{1,4})\s*days?\b/i,
    /\blifecycle\s+(\d{1,4})[-\s]days?\b/i,
    /\b(\d{1,4})\s*d\b.*\blifecycle\b/i,
    /\b(\d{1,4})\s+days?\b.*\blifecycle\b/i,
  ];

  // Only extract current-version days from non-noncurrent phrasing by
  // excluding phrases that match noncurrent keywords.
  let currentDays: number | undefined;
  if (!hasNoncurrentKeyword) {
    for (const re of currentPatterns) {
      const m = re.exec(intent);
      if (!m) continue;
      const n = Number(m[1]);
      if (!Number.isFinite(n) || n < 1) continue;
      currentDays = n;
      break;
    }
  } else {
    // Variation C: intent has BOTH current lifecycle days AND noncurrent days.
    // Look for explicit "lifecycle Nd" / "lifecycle N days" pattern that is
    // NOT part of the noncurrent clause. Use the patterns against the full
    // intent — if a match doesn't overlap with the noncurrent value, it's current.
    for (const re of currentPatterns) {
      const m = re.exec(intent);
      if (!m) continue;
      const n = Number(m[1]);
      if (!Number.isFinite(n) || n < 1) continue;
      // Only treat as current-version days when it differs from noncurrent days,
      // or when it specifically comes from "lifecycle Nd" phrasing (not just Nd alone).
      if (n !== noncurrentDays) {
        currentDays = n;
      }
      break;
    }
  }

  // Nothing extracted → no-op
  if (currentDays === undefined && noncurrentDays === undefined) return;

  elicited["EnableLifecycle"] = true;

  if (currentDays !== undefined) {
    elicited["LifecycleExpireOnly"] = true;
    elicited["LifecycleExpirationDays"] = String(currentDays);
    advisories.push({
      code: S3_LIFECYCLE_SIMPLIFIED_CODE,
      message: `Lifecycle simplified to expire-after-${currentDays}d. No IA transition was requested.`,
      hint: S3_LIFECYCLE_SIMPLIFIED_HINT,
      details: { days: currentDays },
    });
  }

  if (noncurrentDays !== undefined) {
    elicited["LifecycleNoncurrentExpirationDays"] = String(noncurrentDays);

    // Warn when versioning is not mentioned — NoncurrentVersionExpiration
    // has no effect without versioning enabled.
    // Single regex covers "version", "versioning", "versioned" (the prior
    // second clause `/\bversioning\s+enabled\b/` was a strict subset).
    const hasVersioningMention = /\bversion(?:ing|ed)?\b/.test(intentLower);
    if (!hasVersioningMention) {
      advisories.push({
        code: S3_NONCURRENT_REQUIRES_VERSIONING_CODE,
        message:
          "NoncurrentVersionExpiration requires versioning to be enabled. Versioning will be auto-enabled.",
        hint: S3_NONCURRENT_REQUIRES_VERSIONING_HINT,
        details: { days: noncurrentDays },
      });
    }
  }
}
