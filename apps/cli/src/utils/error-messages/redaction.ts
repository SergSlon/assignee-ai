/**
 * Sensitive-data redaction — thin re-export shim.
 *
 * The canonical implementation lives in `@assignee/core/utils/redact.ts`
 * (lifted in Story 50-4 Wave 5.1 so the in-core CloudControlAdapter can
 * call it without reaching back into the CLI app).
 *
 * Partition-aware ARN pattern accepts aws, aws-cn, aws-us-gov, aws-iso,
 * aws-iso-b. See feedback_partition_aware_arn_matching memory.
 */
export { redactSensitive } from "@assignee/core";
