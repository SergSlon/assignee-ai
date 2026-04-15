/**
 * Sensitive-data redaction (M-S5) — scrubs 12-digit account IDs and full ARNs
 * from error messages before they are displayed or logged.
 *
 * Partition-aware ARN pattern accepts aws, aws-cn, aws-us-gov, aws-iso,
 * aws-iso-b via ARN_PATTERN_SOURCE = "arn:aws[\\w-]*:". See
 * feedback_partition_aware_arn_matching memory and the canonical helper at
 * packages/core/src/config/aws-partition.ts.
 *
 * Order matters: ARNs are redacted first (because they contain account IDs)
 * and the remaining bare account IDs are scrubbed afterwards.
 */

import { ARN_PATTERN_SOURCE } from "@assignee/core";

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
