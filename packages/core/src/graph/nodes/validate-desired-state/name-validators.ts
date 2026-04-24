/**
 * Plan-time name validators for 8 AWS resource types (Epic 99 Wave 4 Lane 4a).
 *
 * Each exported function validates the primary name field for its resource
 * type against AWS's published naming rules.  The calling convention matches
 * the existing `validateS3BucketName` contract:
 *   - Empty / undefined name → `{ ok: true }` (let CloudControl or
 *     the plan-generator decide whether auto-generation applies).
 *   - Invalid name → `{ ok: false, error: "...", fix: "..." }`.
 *   - Valid name → `{ ok: true }`.
 */

import type { ValidationResult } from "../validate-desired-state.js";

// ---------------------------------------------------------------------------
// AWS::Lambda::Function — FunctionName
// ---------------------------------------------------------------------------

/**
 * Rules (https://docs.aws.amazon.com/lambda/latest/api/API_CreateFunction.html):
 *   - Charset: [a-zA-Z0-9-_]
 *   - Length: 1-64 characters for a bare name.
 *     (The full qualified ARN form up to 140 chars is handled by CloudControl;
 *     we validate the bare-name case that users typically supply.)
 */
export function validateLambdaName(name: string): ValidationResult {
  if (!name) return { ok: true };

  if (name.length < 1 || name.length > 64) {
    return {
      ok: false,
      error: `Lambda FunctionName "${name}" length ${name.length} is outside the 1-64 character range.`,
      fix: "Use a name between 1 and 64 characters. Leave FunctionName blank to let AWS auto-generate one.",
    };
  }

  if (!/^[a-zA-Z0-9\-_]+$/.test(name)) {
    return {
      ok: false,
      error: `Lambda FunctionName "${name}" contains characters outside [a-zA-Z0-9-_].`,
      fix: "Use only letters, digits, hyphens, and underscores. Spaces, dots, and other special characters are not allowed.",
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// AWS::DynamoDB::Table — TableName
// ---------------------------------------------------------------------------

/**
 * Rules (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.NamingRulesDataTypes.html):
 *   - Charset: [a-zA-Z0-9_.-]
 *   - Length: 3-255 characters.
 */
export function validateDdbTableName(name: string): ValidationResult {
  if (!name) return { ok: true };

  if (name.length < 3 || name.length > 255) {
    return {
      ok: false,
      error: `DynamoDB TableName "${name}" length ${name.length} is outside the 3-255 character range.`,
      fix: "Use a name between 3 and 255 characters.",
    };
  }

  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    return {
      ok: false,
      error: `DynamoDB TableName "${name}" contains characters outside [a-zA-Z0-9_.-].`,
      fix: "Use only letters, digits, underscores, hyphens, and periods.",
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// AWS::EC2::SecurityGroup — GroupName
// ---------------------------------------------------------------------------

/**
 * Rules (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/working-with-security-groups.html):
 *   - Charset: [a-zA-Z0-9 ._\-:/()#,@\[\]+=;{}!$*]
 *   - Length: 1-255 (EC2-Classic) / 1-64 (VPC). We enforce 1-255 and warn
 *     users that VPC SGs are limited to 64. Interpretation: we use the VPC
 *     limit (1-64) as the stricter rule since VPC is now the default and
 *     EC2-Classic is retired — flagged below.
 *   - Must NOT start with "sg-" (prefix reserved for security group IDs).
 *   - Must NOT be exactly "default" (reserved by AWS for the default VPC SG).
 */
export function validateSgName(name: string): ValidationResult {
  if (!name) return { ok: true };

  // VPC length limit (stricter; EC2-Classic is retired since Aug 2022).
  if (name.length < 1 || name.length > 255) {
    return {
      ok: false,
      error: `EC2 SecurityGroup GroupName "${name}" length ${name.length} is outside the 1-255 character range.`,
      fix: "Use a name between 1 and 255 characters (VPC security groups are further limited to 64 characters).",
    };
  }

  if (name === "default") {
    return {
      ok: false,
      error: `EC2 SecurityGroup GroupName "default" is reserved by AWS for the default VPC security group.`,
      fix: 'Choose a different name. "default" is reserved; use a descriptive name like "app-web-sg".',
    };
  }

  if (/^sg-/.test(name)) {
    return {
      ok: false,
      error: `EC2 SecurityGroup GroupName "${name}" starts with "sg-" which is reserved for security group IDs.`,
      fix: 'Remove the "sg-" prefix from the name. Security group IDs (e.g. "sg-0abc1234") are assigned by AWS.',
    };
  }

  // Charset: letters, digits, space, and the punctuation AWS permits.
  if (!/^[a-zA-Z0-9 ._\-:/()#,@[\]+=;{}!$*]+$/.test(name)) {
    return {
      ok: false,
      error: `EC2 SecurityGroup GroupName "${name}" contains characters not allowed by AWS.`,
      fix: "Use letters, digits, spaces, and punctuation from the set: . _ - : / ( ) # , @ [ ] + = ; { } ! $ *",
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// AWS::IAM::Role — RoleName
// ---------------------------------------------------------------------------

/**
 * Rules (https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html):
 *   - Charset: [\w+=,.@-]  (word chars + +=,.@-)
 *   - Length: 1-64 characters.
 *
 * Interpretation note: \w covers [a-zA-Z0-9_]; the full allowed set is
 * [a-zA-Z0-9_+=,.@-].
 */
export function validateIamRoleName(name: string): ValidationResult {
  if (!name) return { ok: true };

  if (name.length < 1 || name.length > 64) {
    return {
      ok: false,
      error: `IAM RoleName "${name}" length ${name.length} is outside the 1-64 character range.`,
      fix: "Use a name between 1 and 64 characters.",
    };
  }

  if (!/^[\w+=,.@\-]+$/.test(name)) {
    return {
      ok: false,
      error: `IAM RoleName "${name}" contains characters outside [a-zA-Z0-9_+=,.@-].`,
      fix: "Use only letters, digits, and the characters: _ + = , . @ -",
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// AWS::RDS::DBInstance — DBInstanceIdentifier
// ---------------------------------------------------------------------------

/**
 * Rules (https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html):
 *   - Charset: [a-zA-Z][a-zA-Z0-9-]*  (must start with a letter)
 *   - Must NOT end with a hyphen.
 *   - Must NOT contain consecutive hyphens ("--").
 *   - Length: 1-63 characters.
 *
 * Note: AWS actually normalises identifiers to lowercase, but accepts mixed
 * case at the API level. We accept mixed case to avoid false positives.
 */
export function validateRdsDbIdentifier(name: string): ValidationResult {
  if (!name) return { ok: true };

  if (name.length < 1 || name.length > 63) {
    return {
      ok: false,
      error: `RDS DBInstanceIdentifier "${name}" length ${name.length} is outside the 1-63 character range.`,
      fix: "Use an identifier between 1 and 63 characters.",
    };
  }

  if (!/^[a-zA-Z]/.test(name)) {
    return {
      ok: false,
      error: `RDS DBInstanceIdentifier "${name}" must start with a letter.`,
      fix: 'Begin the identifier with a letter (a-z or A-Z). Example: "prod-db-01" instead of "01-prod-db".',
    };
  }

  if (!/^[a-zA-Z0-9-]+$/.test(name)) {
    return {
      ok: false,
      error: `RDS DBInstanceIdentifier "${name}" contains characters outside [a-zA-Z0-9-].`,
      fix: "Use only letters, digits, and hyphens. Underscores, dots, and spaces are not allowed.",
    };
  }

  if (name.endsWith("-")) {
    return {
      ok: false,
      error: `RDS DBInstanceIdentifier "${name}" must not end with a hyphen.`,
      fix: `Remove the trailing hyphen. Example: "${name.slice(0, -1)}".`,
    };
  }

  if (/--/.test(name)) {
    return {
      ok: false,
      error: `RDS DBInstanceIdentifier "${name}" contains consecutive hyphens ("--"), which AWS forbids.`,
      fix: 'Replace "--" with a single "-". Example: "prod-db-01" instead of "prod--db-01".',
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// AWS::SQS::Queue — QueueName
// ---------------------------------------------------------------------------

/**
 * Rules (https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-queues.html):
 *   - Charset: [a-zA-Z0-9_-]
 *   - Length: 1-80 characters.
 *   - FIFO queues must end with ".fifo".
 *   - Non-FIFO queues must NOT end with ".fifo".
 *
 * Interpretation: we detect the ".fifo" suffix. If present we validate FIFO
 * rules (name before ".fifo" must itself be valid and ≤ 75 chars so that
 * the total stays ≤ 80). If absent we validate standard queue rules.
 */
export function validateSqsQueueName(name: string): ValidationResult {
  if (!name) return { ok: true };

  const isFifo = name.endsWith(".fifo");
  const baseName = isFifo ? name.slice(0, -5) : name;

  if (name.length < 1 || name.length > 80) {
    return {
      ok: false,
      error: `SQS QueueName "${name}" length ${name.length} is outside the 1-80 character range.`,
      fix: 'Use a name between 1 and 80 characters (including the ".fifo" suffix for FIFO queues).',
    };
  }

  // Charset check on the base name (exclude the ".fifo" suffix if present).
  if (!/^[a-zA-Z0-9_\-]+$/.test(baseName)) {
    return {
      ok: false,
      error: `SQS QueueName "${name}" contains characters outside [a-zA-Z0-9_-] (before the optional ".fifo" suffix).`,
      fix: 'Use only letters, digits, hyphens, and underscores. Dots are only allowed as part of the ".fifo" suffix.',
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// AWS::SNS::Topic — TopicName
// ---------------------------------------------------------------------------

/**
 * Rules (https://docs.aws.amazon.com/sns/latest/dg/sns-create-topic.html):
 *   - Charset: [a-zA-Z0-9_-]
 *   - Length: 1-256 characters.
 *   - FIFO topics must end with ".fifo".
 *
 * Same ".fifo" semantics as SQS.
 */
export function validateSnsTopicName(name: string): ValidationResult {
  if (!name) return { ok: true };

  const isFifo = name.endsWith(".fifo");
  const baseName = isFifo ? name.slice(0, -5) : name;

  if (name.length < 1 || name.length > 256) {
    return {
      ok: false,
      error: `SNS TopicName "${name}" length ${name.length} is outside the 1-256 character range.`,
      fix: 'Use a name between 1 and 256 characters (including the ".fifo" suffix for FIFO topics).',
    };
  }

  if (!/^[a-zA-Z0-9_\-]+$/.test(baseName)) {
    return {
      ok: false,
      error: `SNS TopicName "${name}" contains characters outside [a-zA-Z0-9_-] (before the optional ".fifo" suffix).`,
      fix: 'Use only letters, digits, hyphens, and underscores. Dots are only allowed as part of the ".fifo" suffix.',
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// AWS::KMS::Alias — AliasName
// ---------------------------------------------------------------------------

/**
 * Rules (https://docs.aws.amazon.com/kms/latest/APIReference/API_CreateAlias.html):
 *   - Must start with "alias/".
 *   - Overall length (including "alias/"): 1-256 characters.
 *   - The part after "alias/" must be non-empty and may contain
 *     [a-zA-Z0-9/_-].
 *   - Must NOT start with "alias/aws" (reserved for AWS-managed keys).
 */
export function validateKmsAliasName(name: string): ValidationResult {
  if (!name) return { ok: true };

  if (!name.startsWith("alias/")) {
    return {
      ok: false,
      error: `KMS AliasName "${name}" must start with "alias/".`,
      fix: 'Prefix the alias with "alias/". Example: "alias/my-app-key" instead of "my-app-key".',
    };
  }

  if (name.startsWith("alias/aws")) {
    return {
      ok: false,
      error: `KMS AliasName "${name}" starts with "alias/aws" which is reserved for AWS-managed keys.`,
      fix: 'Choose a different alias prefix. "alias/aws/" is reserved; use "alias/my-app-key" instead.',
    };
  }

  if (name.length < 1 || name.length > 256) {
    return {
      ok: false,
      error: `KMS AliasName "${name}" length ${name.length} is outside the 1-256 character range.`,
      fix: 'Keep the full alias name (including "alias/") between 1 and 256 characters.',
    };
  }

  const suffix = name.slice(6); // strip "alias/"
  if (!suffix) {
    return {
      ok: false,
      error: `KMS AliasName "${name}" has an empty suffix — the part after "alias/" must be non-empty.`,
      fix: 'Add a name after "alias/". Example: "alias/my-app-key".',
    };
  }

  if (!/^[a-zA-Z0-9/_\-]+$/.test(suffix)) {
    return {
      ok: false,
      error: `KMS AliasName "${name}" suffix contains characters outside [a-zA-Z0-9/_-].`,
      fix: 'Use only letters, digits, forward slashes, hyphens, and underscores after "alias/".',
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// AWS::ECR::Repository — RepositoryName
// ---------------------------------------------------------------------------

/**
 * Rules (https://docs.aws.amazon.com/AmazonECR/latest/APIReference/API_CreateRepository.html):
 *   - Lowercase only.
 *   - Length: 2-256 characters.
 *   - Pattern: (?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*
 *   - No leading or trailing separator characters (., _, -).
 *   - Each path component (separated by /) must start and end with
 *     [a-z0-9]; separators . _ - must be surrounded by [a-z0-9].
 */
const ECR_COMPONENT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function validateEcrRepositoryName(name: string): ValidationResult {
  if (!name) return { ok: true };

  if (name.length < 2 || name.length > 256) {
    return {
      ok: false,
      error: `ECR RepositoryName "${name}" length ${name.length} is outside the 2-256 character range.`,
      fix: "Use a name between 2 and 256 characters.",
    };
  }

  // Uppercase check (ECR is lowercase-only).
  if (/[A-Z]/.test(name)) {
    return {
      ok: false,
      error: `ECR RepositoryName "${name}" contains uppercase characters; ECR names must be lowercase.`,
      fix: `Use "${name.toLowerCase()}" instead (all lowercase).`,
    };
  }

  // Validate each path component split by '/'.
  const components = name.split("/");
  for (const component of components) {
    if (!ECR_COMPONENT_PATTERN.test(component)) {
      return {
        ok: false,
        error: `ECR RepositoryName "${name}" path component "${component}" is invalid. Each component must start and end with [a-z0-9] with only [._-] as internal separators.`,
        fix: "Each path component must begin and end with a lowercase letter or digit. Separators (. _ -) must be surrounded by [a-z0-9] and cannot appear consecutively.",
      };
    }
  }

  return { ok: true };
}
