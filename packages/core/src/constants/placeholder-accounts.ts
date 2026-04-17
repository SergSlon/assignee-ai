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

/**
 * Regex to extract the 12-digit account ID from an ARN.
 * Partition-aware: matches arn:aws, arn:aws-cn, arn:aws-us-gov.
 */
export const ARN_ACCOUNT_REGEX = /^arn:aws[\w-]*:[\w-]*:[\w-]*:(\d{12}):/;
