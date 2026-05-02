/**
 * Sensitive-data redaction (M-S5) — scrubs 12-digit account IDs and full ARNs
 * from error messages before they are displayed or logged.
 *
 * Partition-aware ARN pattern accepts aws, aws-cn, aws-us-gov, aws-iso,
 * aws-iso-b via ARN_PATTERN_SOURCE = "arn:aws[\\w-]*:". See
 * feedback_partition_aware_arn_matching memory.
 *
 * Order matters: ARNs are redacted first (because they contain account IDs)
 * and the remaining bare account IDs are scrubbed afterwards.
 *
 * Lifted from `apps/cli/src/utils/error-messages/redaction.ts` in Story
 * 50-4 Wave 5.1 so the in-core CloudControlAdapter and other lifted
 * services can call it without reaching back into the CLI.
 *
 * W1-01 (Epic 100): `stripSensitiveFromElicited()` — elicited-field marker
 * layer. Complements the CFN-property key-name allowlist in
 * `checkpoint/redaction.ts` (which handles serialised CFN desiredState).
 * This helper handles in-memory elicited-option records BEFORE they reach
 * any persistence boundary (memory-recorder / checkpoint / OTEL).
 */

import { ARN_PATTERN_SOURCE } from "../config/aws-partition.js";
import type { ResourceField } from "../resource-plugins/types.js";

const ARN_PATTERN = new RegExp(
  `${ARN_PATTERN_SOURCE}[a-z0-9-]+:[a-z0-9-]*:\\d{12}:[^\\s]*`,
  "g",
);
const ACCOUNT_ID_PATTERN = /\b\d{12}\b/g;

/**
 * AWS access key identifier pattern (AKIA = long-term IAM key,
 * ASIA = STS short-term session key). Matches the 20-char key-id
 * prefix that appears in error messages (e.g. "permission denied
 * for AKIAIOSFODNN7EXAMPLE"). Defense-in-depth layer complementing
 * the allowlist-based redactSensitiveFields — this helper operates
 * on free-form strings rather than structured objects.
 */
const AKIA_STRING_PATTERN = /A[KS]IA[0-9A-Z]{16}/g;

// ── SEC-007: Multi-provider secret patterns ───────────────────────────────
//
// Each pattern is prefix-anchored and character-class-bounded to minimise
// false-positives on bucket names, ARNs, and other long opaque identifiers.
//
// Provider inventory:
//   Anthropic   sk-ant-[api03|apikey]-...  (legacy + current API key shapes)
//   OpenAI      sk-proj-... (project key) or sk-[20 base58 chars] (legacy)
//   GitHub PAT  ghp_... (classic PAT), gho_... (OAuth token),
//               github_pat_... (fine-grained PAT)
//   Slack       xoxb-... (bot token), xoxp-... (user token)
//   Google AI   AIza followed by 35 base64url chars
//   JWT         eyJ prefix (base64url-encoded JSON header) — prefix only,
//               stops at whitespace to avoid collateral on short test strings
//
// AWS session tokens are handled by the SENSITIVE_KEY_NAMES allowlist in
// checkpoint/redaction.ts (key-name path) and must not be added here because
// the base64 shape is too generic and would produce false-positives.

/** Anthropic API key: sk-ant-api03-... or sk-ant-... (legacy) */
const ANTHROPIC_KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]{20,}/g;

/** OpenAI project key (sk-proj-...) or legacy user key (sk- + ~48 base58 chars) */
const OPENAI_KEY_PATTERN = /sk-(?:proj-)[A-Za-z0-9_-]{20,}/g;

/** GitHub classic PAT (ghp_), OAuth token (gho_), fine-grained PAT (github_pat_) */
const GITHUB_TOKEN_PATTERN = /(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{20,}/g;

/** Slack bot token (xoxb-) and user token (xoxp-) */
const SLACK_TOKEN_PATTERN = /xox[bp]-[A-Za-z0-9-]{10,}/g;

/** Google AI / Cloud API key: AIza + 35 URL-safe base64 chars */
const GOOGLE_AI_KEY_PATTERN = /AIza[0-9A-Za-z_-]{35}/g;

/**
 * JWT prefix: eyJ (base64url-encoded `{`) as used in header + payload parts.
 * Stops at whitespace — does NOT attempt to match the full dot-separated token
 * to avoid false-positives on short strings in unit tests.
 * Minimum 20 chars after prefix to avoid matching the literal string "eyJ" alone.
 */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+){1,2}/g;

export function redactSensitive(message: string): string {
  if (!message) return message;
  return message
    .replace(ARN_PATTERN, "[ARN]")
    .replace(ACCOUNT_ID_PATTERN, "[ACCOUNT]")
    .replace(AKIA_STRING_PATTERN, "[AKIA]")
    .replace(ANTHROPIC_KEY_PATTERN, "[ANTHROPIC_KEY]")
    .replace(OPENAI_KEY_PATTERN, "[OPENAI_KEY]")
    .replace(GITHUB_TOKEN_PATTERN, "[GITHUB_TOKEN]")
    .replace(SLACK_TOKEN_PATTERN, "[SLACK_TOKEN]")
    .replace(GOOGLE_AI_KEY_PATTERN, "[GOOGLE_KEY]")
    .replace(JWT_PATTERN, "[JWT]");
}

/**
 * Epic 92 u.e (D-27) — ARN-preserving account-id redaction for LLM prompts.
 *
 * Difference from `redactSensitive`: this helper scrubs the 12-digit
 * account segment *inside* an ARN but keeps the ARN skeleton (service,
 * region, resource name) intact. That is the minimum information the
 * LLM needs to produce a plan that references the same resource the
 * user just typed about — and it's also enough for the user to verify
 * in the plan box that the right topic / role / bucket was targeted.
 *
 * Before this helper:
 *   - Prompt   `"create sub to arn:aws:sns:us-east-1:123456789012:my-topic"`
 *     was redacted to `"create sub to [ARN]"` by `redactSensitive`.
 *   - LLM emitted `{"TopicArn": "[ARN]"}` back verbatim.
 *   - Plan table showed `Topic Arn   [ARN]` — user could not verify
 *     which topic the subscription pointed at (D-27).
 *
 * With this helper:
 *   - Prompt   → `"create sub to arn:aws:sns:us-east-1:[ACCOUNT]:my-topic"`.
 *   - LLM emits `{"TopicArn": "arn:aws:sns:us-east-1:[ACCOUNT]:my-topic"}`.
 *   - Plan table shows the region + topic name; only the account slot
 *     is scrubbed, matching the security property L5-H2 cares about
 *     (no 12-digit account digits reach the model).
 *
 * Bare 12-digit account IDs that are NOT inside an ARN are still
 * replaced with `[ACCOUNT]` because there is no skeleton to preserve.
 *
 * Partition-aware: honors the same partition set as `redactSensitive`
 * (aws, aws-cn, aws-us-gov, aws-iso, aws-iso-b) via `ARN_PATTERN_SOURCE`.
 */
const ACCOUNT_IN_ARN_PATTERN = new RegExp(
  `(${ARN_PATTERN_SOURCE}[a-z0-9-]+:[a-z0-9-]*:)\\d{12}(:)`,
  "g",
);

export function redactAccountIdsInPrompt(message: string): string {
  if (!message) return message;
  // Order matters: replace the account slot inside ARNs first so we
  // don't double-count a match. Then sweep any bare 12-digit account
  // IDs that weren't captured by the ARN pattern.
  return message
    .replace(ACCOUNT_IN_ARN_PATTERN, "$1[ACCOUNT]$2")
    .replace(ACCOUNT_ID_PATTERN, "[ACCOUNT]");
}

// ── Elicited-field sensitive marker (W1-01 / Epic 100) ────────────────────

/** Value used to mask sensitive elicited-field values. */
export const ELICITED_REDACTED_VALUE = "[REDACTED]";

/**
 * Builds a fast lookup set of field names that are marked `sensitive: true`
 * from a plugin's field definitions. Used by `stripSensitiveFromElicited`.
 *
 * @param fields - Flat list of ResourceField definitions (commonFields +
 *   advancedFields from a plugin, or a combined list across plugins).
 * @returns Set of field names whose `sensitive` flag is true.
 */
export function buildSensitiveFieldSet(
  fields: ReadonlyArray<ResourceField>,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const field of fields) {
    if (field.sensitive === true) {
      names.add(field.name);
    }
  }
  return names;
}

/**
 * Returns a shallow copy of `elicitedRecord` with VALUES of sensitive fields
 * replaced by `"[REDACTED]"`. Non-sensitive field values are passed through
 * unchanged (including nested objects — this helper is intentionally
 * SHALLOW: nested CFN property redaction is the checkpoint/redaction layer's
 * responsibility).
 *
 * Usage: call with the plugin's field definitions before writing the
 * elicited-options record to any persistence boundary (memory-recorder,
 * checkpoint `elicitedOptions`, OTEL exporter extras).
 *
 * Back-compat: fields whose `sensitive` flag is absent or false are left
 * untouched, so pre-W1 plugins work without modification.
 *
 * @param elicitedRecord - The raw elicited-options map (e.g. from wizard).
 * @param sensitiveNames  - Set of field names that carry credential material.
 *   Build once per plugin invocation via `buildSensitiveFieldSet(fields)`.
 * @returns A new object — the input is never mutated.
 *
 * @example
 * const sensitive = buildSensitiveFieldSet([...commonFields, ...advancedFields]);
 * const safe = stripSensitiveFromElicited(elicitedOptions, sensitive);
 * await writePatternRecord(patternId, safe);
 */
export function stripSensitiveFromElicited(
  elicitedRecord: Record<string, unknown>,
  sensitiveNames: ReadonlySet<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(elicitedRecord)) {
    result[key] = sensitiveNames.has(key) ? ELICITED_REDACTED_VALUE : value;
  }
  return result;
}
