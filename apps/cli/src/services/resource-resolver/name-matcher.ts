/**
 * Name ↔ ARN matching helper for lookup-by-name.
 *
 * Supports alternate forms users commonly paste (leading-slash SSM
 * parameters, CloudWatch Logs log groups with/without leading slash).
 *
 * @see Story 18.5
 */

import { extractIdentifierFromArn } from "@assignee/core";

/**
 * Checks whether a given user-provided `name` matches the identifier encoded
 * in `arn`. Supports multiple valid normalizations so users can destroy a
 * resource via the same string that appears in `assignee list`:
 *
 * - Exact match against the extracted ARN identifier
 * - SSM parameters: accept both leading-slash ("/foo/bar") and bare ("foo/bar")
 *   forms; the canonical SSM identifier always has a leading slash but users
 *   commonly paste the bare form they originally created.
 * - CloudWatch Logs log groups: accept with/without leading slash for the same
 *   reason (e.g. "/aws/lambda/fn" vs "aws/lambda/fn").
 */
export function matchesName(arn: string, name: string): boolean {
  const nameFromArn = extractIdentifierFromArn(arn);
  if (nameFromArn === name) return true;

  // SSM parameters and CloudWatch Logs log groups use leading-slash
  // identifiers canonically, but users routinely paste the bare form that
  // they originally supplied on create (e.g. `smoke-test-x` vs
  // `/smoke-test-x`). For these types only, also match the slash-stripped
  // variant so `assignee destroy` accepts both forms. We do NOT fall back to
  // a global slash-stripping match — that would make "/my-bucket" match an
  // unrelated S3 bucket named "my-bucket".
  const isSlashPrefixedType =
    arn.includes(":parameter/") || arn.includes(":log-group:");
  if (!isSlashPrefixedType) return false;

  const stripLeading = (s: string) => (s.startsWith("/") ? s.slice(1) : s);
  return stripLeading(nameFromArn) === stripLeading(name);
}
