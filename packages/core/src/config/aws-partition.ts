/**
 * AWS partition helpers — single source of truth for region→partition
 * derivation and ARN-prefix matching across the codebase.
 *
 * Context
 * -------
 * AWS ARNs embed a `partition` segment (`arn:<partition>:<service>:...`).
 * The published partitions as of 2026-04 are:
 *   - `aws`        — commercial regions (us-east-1, eu-west-1, ap-*, etc.)
 *   - `aws-cn`     — China (cn-north-1, cn-northwest-1)
 *   - `aws-us-gov` — GovCloud (us-gov-west-1, us-gov-east-1)
 *   - `aws-iso`    — US ISO (us-iso-east-1, us-iso-west-1)
 *   - `aws-iso-b`  — US ISOB (us-isob-east-1)
 *
 * AWS has announced additional secret-region partitions (`aws-iso-e`,
 * `aws-iso-f`) whose region prefixes are not yet stable in the public
 * SDK. We fall back to `aws-iso` for any `us-iso*-*` prefix that is not
 * explicitly ISOB so callers still produce a well-formed ARN.
 *
 * Construction vs. matching
 * -------------------------
 * - **Construction** callers must know the concrete partition string to
 *   splice into an ARN template. Use `getPartitionFromRegion(region)`.
 * - **Matching** (regex / startsWith) must accept *any* partition so
 *   code doesn't silently ignore GovCloud/China/ISO ARNs. Use the
 *   exported `ARN_PATTERN` regex or the `ARN_PATTERN_SOURCE` string
 *   if you need to compose it into a larger pattern.
 *
 * @see feedback_partition_aware_arn_matching (operator memory)
 */

/** Partitions this codebase has been tested against. */
export type AwsPartition =
  | "aws"
  | "aws-cn"
  | "aws-us-gov"
  | "aws-iso"
  | "aws-iso-b";

/**
 * Derives the ARN partition for a given AWS region.
 *
 * Order matters: ISOB regions start with `us-isob-` which also matches
 * `us-iso` as a prefix, so ISOB must be checked before generic ISO.
 *
 * @example
 *   getPartitionFromRegion("us-east-1")       // "aws"
 *   getPartitionFromRegion("us-gov-west-1")   // "aws-us-gov"
 *   getPartitionFromRegion("cn-northwest-1")  // "aws-cn"
 *   getPartitionFromRegion("us-iso-east-1")   // "aws-iso"
 *   getPartitionFromRegion("us-isob-east-1")  // "aws-iso-b"
 */
export function getPartitionFromRegion(region: string): AwsPartition {
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  if (region.startsWith("cn-")) return "aws-cn";
  // ISOB must come before ISO — "us-isob-east-1".startsWith("us-iso") is true.
  if (region.startsWith("us-isob-")) return "aws-iso-b";
  if (region.startsWith("us-iso")) return "aws-iso";
  return "aws";
}

/**
 * Canonical ARN-detection regex. Accepts *any* AWS partition — never
 * hardcode `arn:aws:` literals in regex or startsWith checks because
 * that silently drops GovCloud, China, and ISO ARNs.
 *
 * The trailing `[\w-]*` covers `aws`, `aws-cn`, `aws-us-gov`, `aws-iso`,
 * `aws-iso-b`, and any future partitions AWS adds that follow the
 * `aws[-suffix]` naming convention.
 *
 * NOTE: This constant is anchored (`^`) because we primarily use it to
 * detect whether a string IS an ARN. For scanning ARNs embedded in free
 * text (e.g. redaction), compose with the `ARN_PATTERN_SOURCE` string
 * below so `/g` flag + non-anchored start can be applied.
 */
export const ARN_PATTERN = /^arn:aws[\w-]*:/;

/**
 * Non-anchored source form of `ARN_PATTERN`, for composing into larger
 * patterns (e.g. global-scan ARN redaction regexes). Does NOT include
 * the leading `^` anchor.
 */
export const ARN_PATTERN_SOURCE = "arn:aws[\\w-]*:";
