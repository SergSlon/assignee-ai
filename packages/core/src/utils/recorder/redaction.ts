/**
 * Sensitive-data redaction for recorded fixtures.
 *
 * Lifted from `apps/cli/src/utils/recorder/redaction.ts` in Story 50-4
 * Wave 5 Pass A. Preserves feedback_redaction_allowlist_not_denylist:
 * the key list is an explicit allowlist of known-credential fields,
 * NOT a regex denylist that could over-match innocuous keys. The
 * substring scrubbers (access-key pattern and IAM ARN pattern) are
 * narrowly scoped.
 *
 * NOTE: exports `redactSensitive` — this is the KEY-ALLOWLIST redactor
 * used by the recorder. The ARN/account-ID redactor (also named
 * `redactSensitive`) lives in `packages/core/src/utils/redact.ts` and
 * is re-exported from the root `@assignee/core` barrel. Both functions
 * share a name but serve orthogonal purposes and never collide because
 * they are in different sub-modules.
 */
import { CfnKey } from "../../config/cfn-keys.js";

/**
 * Keys whose values must be redacted from recorded fixtures.
 * Prevents accidental credential leakage in test recordings.
 */
const REDACTED_KEYS = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
  "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
  "ASSIGNEE_READER_ACCESS_KEY_ID",
  "ASSIGNEE_READER_SECRET_ACCESS_KEY",
  "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
  "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
  CfnKey.MASTER_USER_PASSWORD,
  CfnKey.SECRET_STRING,
  CfnKey.PASSWORD,
  "accessToken",
  "secretAccessKey",
  "sessionToken",
]);

/**
 * Patterns matched against any string value (key-blind) to catch credentials
 * embedded inside larger payloads (e.g. error messages, LLM prompts, ARNs).
 */
const ACCESS_KEY_PATTERN = /(AKIA|ASIA)[0-9A-Z]{16}/g;
// Partition-aware: aws / aws-us-gov / aws-cn / aws-iso* IAM ARNs all embed
// 12-digit account IDs we must redact. Capture the partition so the
// replacement preserves it for debugging without exposing the account.
const IAM_ARN_ACCOUNT_PATTERN = /arn:(aws(?:-[a-z]+)*):iam::\d{12}:/g;

/**
 * Scrub credential-shaped substrings from a single string value.
 * Exported only for testing — production code should use redactSensitive().
 */
export function redactStringValue(value: string): string {
  return value
    .replace(ACCESS_KEY_PATTERN, "[REDACTED-AKIA]")
    .replace(IAM_ARN_ACCOUNT_PATTERN, "arn:$1:iam::[REDACTED]:");
}

/**
 * Recursively redact sensitive keys AND credential-shaped substrings from
 * any value before writing to disk. Returns a new object (does not mutate
 * the original).
 */
export function redactSensitive(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactStringValue(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(k) && typeof v === "string") {
        result[k] = "[REDACTED]";
      } else {
        result[k] = redactSensitive(v);
      }
    }
    return result;
  }
  return value;
}
