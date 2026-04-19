/**
 * Canonical AWS placeholder account IDs used in documentation examples.
 * These are never real accounts — the LLM frequently hallucinates ARNs
 * containing these IDs when generating desiredState.
 *
 * Shared between:
 * - preflight-guard.ts: detectPlaceholderArn() — blocks plans with placeholder ARNs
 * - plan-generator.ts: stripPlaceholderArns() — proactively strips them before preflight
 *
 * @see https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html
 */
export const PLACEHOLDER_AWS_ACCOUNT_IDS = new Set([
  "123456789012", // Universal AWS docs example
  "111122223333", // Cross-account walkthrough examples
  "222222222222", // Multi-account IAM examples
  "333333333333",
  "444455556666",
  "555555555555",
  "999999999999", // Alternative account example
  "000000000000", // Unit test fixtures
]);

import { ARN_PATTERN_SOURCE } from "../config/aws-partition.js";

/**
 * Regex to extract the 12-digit account ID from an ARN.
 *
 * Partition-aware: built from the canonical `ARN_PATTERN_SOURCE` so it
 * accepts every published AWS partition (`aws`, `aws-cn`, `aws-us-gov`,
 * `aws-iso`, `aws-iso-b`, and the announced-but-not-yet-public
 * `aws-iso-e` / `aws-iso-f`). It rejects malformed partitions like
 * `arn:aws_x:` (underscore) or `arn:AWS_BAD_PARTITION:` (uppercase)
 * that the old `[\w-]*` pattern would have silently accepted.
 *
 * Closes L5-003 (Story 56-it2-02): canonical partition matching.
 */
export const ARN_ACCOUNT_REGEX = new RegExp(
  `^${ARN_PATTERN_SOURCE}[\\w-]*:[\\w-]*:(\\d{12}):`,
);
