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
 * AWS has announced additional partitions beyond the five originally
 * public ones. `aws-iso-e` covers `eu-isoe-west-1` (EU Sovereign Cloud
 * / DE BSI C5 / FR SecNumCloud). `aws-iso-f` region prefixes are not
 * yet stable in the public SDK. We fall back to `aws-iso` for any
 * `us-iso*-*` prefix that is not explicitly ISOB so callers still
 * produce a well-formed ARN.
 *
 * W5-02 (P054 → L1-F08 + L3-F17): eu-isoe-west-1 maps to aws-iso-e.
 * This is the EU Sovereign Cloud / DE BSI C5 / FR SecNumCloud partition.
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

/**
 * Partitions this codebase has been tested against.
 *
 * `aws-iso-e` / `aws-iso-f` are AWS-announced secret-region partitions
 * whose region-prefix mapping is not yet public in the SDK. They are
 * included in the union and in `ARN_PATTERN` so ARNs handed to us by
 * downstream systems (billing records, CloudTrail, etc.) parse correctly
 * even before we add a region→partition mapping for them.
 */
export type AwsPartition =
  | "aws"
  | "aws-cn"
  | "aws-us-gov"
  | "aws-iso"
  | "aws-iso-b"
  | "aws-iso-e"
  | "aws-iso-f";

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
 *   getPartitionFromRegion("eu-isoe-west-1")  // "aws-iso-e"
 */
export function getPartitionFromRegion(region: string): AwsPartition {
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  if (region.startsWith("cn-")) return "aws-cn";
  // ISOB must come before ISO — "us-isob-east-1".startsWith("us-iso") is true.
  if (region.startsWith("us-isob-")) return "aws-iso-b";
  // EU Sovereign Cloud (W5-02 P054): eu-isoe-* maps to aws-iso-e.
  // Must check eu-isoe- before falling through to the commercial aws path.
  if (region.startsWith("eu-isoe-")) return "aws-iso-e";
  if (region.startsWith("us-iso")) return "aws-iso";
  return "aws";
}

/**
 * Canonical ARN-detection regex. Accepts *any* AWS partition — never
 * hardcode `arn:aws:` literals in regex or startsWith checks because
 * that silently drops GovCloud, China, and ISO ARNs.
 *
 * Shape: `arn:aws` + zero-or-more lowercase-letter-only suffix segments
 * (each prefixed by `-`). This matches the current 5 partitions AND the
 * announced `aws-iso-e` / `aws-iso-f` but rejects malformed partitions
 * like `arn:aws_x:` (underscore) or `arn:aws1:` (digit) that the older
 * `[\w-]*` pattern would have accepted.
 *
 * NOTE: This constant is anchored (`^`) because we primarily use it to
 * detect whether a string IS an ARN. For scanning ARNs embedded in free
 * text (e.g. redaction), compose with the `ARN_PATTERN_SOURCE` string
 * below so `/g` flag + non-anchored start can be applied.
 */
export const ARN_PATTERN = /^arn:aws(?:-[a-z]+)*:/;

/**
 * Non-anchored source form of `ARN_PATTERN`, for composing into larger
 * patterns (e.g. global-scan ARN redaction regexes). Does NOT include
 * the leading `^` anchor.
 */
export const ARN_PATTERN_SOURCE = "arn:aws(?:-[a-z]+)*:";

/**
 * Returns true when `value` is an ARN whose service segment matches
 * `service`, regardless of partition. Prefer this over
 * `value.startsWith("arn:aws:<service>:")` (which silently rejects
 * GovCloud, China, and ISO ARNs).
 *
 * @example
 *   isArnOfService("arn:aws:iam::123:role/x", "iam")           // true
 *   isArnOfService("arn:aws-us-gov:iam::123:role/x", "iam")    // true
 *   isArnOfService("arn:aws-cn:sqs:cn-north-1:0:q", "sqs")     // true
 *   isArnOfService("arn:aws:iam::123:role/x", "sqs")           // false
 *   isArnOfService("not-an-arn", "iam")                        // false
 */
export function isArnOfService(value: string, service: string): boolean {
  if (!ARN_PATTERN.test(value)) return false;
  // ARN shape: arn:<partition>:<service>:<region>:<account>:<resource>
  // Split at most 4 times so `value.split(":", 4)` gives [arn, partition,
  // service, region-or-start-of-resource]. Index 2 is the service segment.
  const parts = value.split(":", 4);
  return parts[2] === service;
}
