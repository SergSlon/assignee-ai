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
 */

import { ARN_PATTERN_SOURCE } from "../config/aws-partition.js";

const ARN_PATTERN = new RegExp(
  `${ARN_PATTERN_SOURCE}[a-z0-9-]+:[a-z0-9-]*:\\d{12}:[^\\s]*`,
  "g",
);
const ACCOUNT_ID_PATTERN = /\b\d{12}\b/g;

export function redactSensitive(message: string): string {
  if (!message) return message;
  return message
    .replace(ARN_PATTERN, "[ARN]")
    .replace(ACCOUNT_ID_PATTERN, "[ACCOUNT]");
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
