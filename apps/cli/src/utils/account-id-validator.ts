/**
 * W3-04 (Epic 100 Round 5) — AWS account-ID validator.
 *
 * Validates that a string is a valid AWS account ID:
 *   - Exactly 12 decimal digits.
 *   - NOT one of the known placeholder IDs used in docs and tests
 *     (per `feedback_placeholder_arn_preflight_guard` memory).
 *
 * Partition-agnostic: GovCloud and China account IDs are also 12-digit
 * numeric strings — the partition prefix appears only in ARNs, not in
 * the bare account ID itself.
 *
 * Placeholder IDs rejected:
 *   - `123456789012` — AWS documentation canonical example.
 *   - `210987654321` — project-internal redacted-test pattern
 *     (`feedback_no_real_account_ids_in_repo`).
 */

// ── Constants ──────────────────────────────────────────────────────────

const ACCOUNT_ID_REGEX = /^\d{12}$/;

/**
 * Known placeholder / example account IDs that must be rejected.
 * See `feedback_placeholder_arn_preflight_guard` and
 * `feedback_no_real_account_ids_in_repo`.
 */
export const PLACEHOLDER_ACCOUNT_IDS = new Set<string>([
  "123456789012", // AWS docs canonical example
  "210987654321", // project-internal redacted-test pattern
]);

// ── Validator ──────────────────────────────────────────────────────────

export interface AccountIdValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate `id` as an AWS account ID.
 *
 * @param id - The string to validate.
 * @returns `{ valid: true }` on success, `{ valid: false, reason }` otherwise.
 */
export function validateAccountId(id: string): AccountIdValidationResult {
  if (!ACCOUNT_ID_REGEX.test(id)) {
    return {
      valid: false,
      reason: "Invalid account ID: must be 12 digits",
    };
  }

  if (PLACEHOLDER_ACCOUNT_IDS.has(id)) {
    return {
      valid: false,
      reason:
        "Placeholder account ID rejected (per feedback_placeholder_arn_preflight_guard)",
    };
  }

  return { valid: true };
}
