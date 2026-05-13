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
 * Populated fields in `elicited`:
 *   - `EnableLifecycle`         = true
 *   - `LifecycleExpireOnly`     = true  (bare expire-only path)
 *   - `LifecycleExpirationDays` = N     (number of days parsed from intent)
 *
 * Advisory emitted (bare path only):
 *   code:    "S3_LIFECYCLE_SIMPLIFIED"
 *   message: "Lifecycle simplified to expire-after-<N>d."
 *   hint:    "Use 'transition to IA after Nd then expire after Md' for a multi-tier ladder."
 */

import { RESOURCE_TYPES } from "@/index.js";
import type { Advisory } from "../intent-types.js";

/**
 * Advisory code for simplified lifecycle.
 * Stable machine-readable code for downstream consumers.
 */
export const S3_LIFECYCLE_SIMPLIFIED_CODE = "S3_LIFECYCLE_SIMPLIFIED";

/**
 * The canonical advisory hint for the simplified lifecycle path.
 * Exposed as a constant so tests can assert the exact string.
 */
export const S3_LIFECYCLE_SIMPLIFIED_HINT =
  "Use 'transition to IA after Nd then expire after Md' for a multi-tier ladder.";

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

  // Match bare "lifecycle Nd" / "lifecycle N days" / "lifecycle N-day"
  // Also matches "lifecycle 30 days", "lifecycle 90d", etc.
  // The day value is required — we won't fire on "lifecycle rules" alone.
  const patterns: RegExp[] = [
    /\blifecycle\s+(\d{1,4})\s*d\b/i,
    /\blifecycle\s+(\d{1,4})\s*days?\b/i,
    /\blifecycle\s+(\d{1,4})[-\s]days?\b/i,
    /\b(\d{1,4})\s*d\b.*\blifecycle\b/i,
    /\b(\d{1,4})\s+days?\b.*\blifecycle\b/i,
  ];

  let days: number | undefined;
  for (const re of patterns) {
    const m = re.exec(intent);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 1) continue;
    days = n;
    break;
  }

  if (days === undefined) return;

  // Set the expire-only lifecycle fields
  elicited["EnableLifecycle"] = true;
  elicited["LifecycleExpireOnly"] = true;
  elicited["LifecycleExpirationDays"] = String(days);

  advisories.push({
    code: S3_LIFECYCLE_SIMPLIFIED_CODE,
    message: `Lifecycle simplified to expire-after-${days}d. No IA transition was requested.`,
    hint: S3_LIFECYCLE_SIMPLIFIED_HINT,
    details: { days },
  });
}
