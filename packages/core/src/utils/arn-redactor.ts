/**
 * arn-redactor.ts — ARN-structure-preserving redactor for LLM prompt boundaries.
 *
 * W10-07 (P051 → L3-F16): Scrubs account IDs and sensitive resource names
 * from ARNs before they enter LLM context, while preserving the ARN's
 * structural semantics (partition, service, region, resource-type prefix).
 * This lets the LLM reason about resource relationships without receiving
 * real account IDs or customer bucket names.
 *
 * Design: allowlist-not-denylist (feedback_redaction_allowlist_not_denylist).
 * The allowlist enumerates safe resource-type prefixes; everything else is
 * redacted. This is the inverse of a regex denylist, which over-matches on
 * benign tokens like PasswordPolicy / TokenValidityUnits / UserData.
 *
 * Partition-aware: uses /^arn:aws[\w-]*:/ per feedback_partition_aware_arn_matching
 * to cover GovCloud (aws-us-gov) and China (aws-cn) partitions.
 *
 * Pure module — no I/O, no side effects. Safe to import from any layer.
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Sentinel replacing a redacted 12-digit AWS account ID. */
export const REDACTED_ACCOUNT_ID = "<account-id-redacted>";

/** Sentinel replacing a redacted resource name / path segment. */
export const REDACTED_RESOURCE = "<resource-redacted>";

/**
 * Allowlisted resource-type prefixes whose names are safe to leave in
 * the LLM context because they do not carry customer-identifying data.
 * Everything NOT on this list has its resource portion redacted.
 *
 * Rationale per resource-type:
 *  - "iam:role/" / "iam:instance-profile/" / "iam:policy/" — role *names*
 *    are usually generic ("LambdaExecRole") not customer-sensitive. Keep so
 *    the LLM can reason about role relationships.
 *  - "s3:::" — S3 bucket names ARE customer-sensitive → NOT allowlisted;
 *    the resource segment is redacted.
 *  - Numbers-only service types (sqs, sns, events) expose queue/topic URLs /
 *    ARNs that embed account — redact.
 * Add entries here as the LLM prompt quality tradeoff changes.
 */
const RESOURCE_ALLOWLIST_PREFIXES: readonly string[] = [
  "role/",
  "instance-profile/",
  "policy/",
  "assumed-role/",
];

// ── ARN detection regex (partition-aware) ────────────────────────────────────

/**
 * Matches a full ARN token including optional trailing path segments.
 * Partition-aware per feedback_partition_aware_arn_matching:
 *   /^arn:aws[\w-]*:/ covers aws, aws-us-gov, aws-cn.
 *
 * ARN format: arn:partition:service:region:account-id:resource
 *   - region and account are optional (S3 ARNs omit both; IAM omits region).
 *   - resource may be "/" or ":" delimited.
 *
 * The regex captures named groups for precise surgery:
 *   (prefix)(accountId)(resource)
 */
const ARN_PATTERN =
  /\barn:(aws[\w-]*):([\w-]+):([\w-]*):((\d{12})|)(:([\w:/.*-]*))?/g;

// ── Core redactor ─────────────────────────────────────────────────────────────

/**
 * Redact a single ARN string.
 *
 * Preserves: partition, service, region (if present).
 * Redacts: 12-digit account ID → `<account-id-redacted>`.
 * Conditionally redacts: resource portion if not allowlisted.
 *
 * Examples:
 *   "arn:aws:iam::210987654321:user/test"
 *   → "arn:aws:iam::<account-id-redacted>:user/<resource-redacted>"
 *
 *   "arn:aws:iam::210987654321:role/LambdaExec"
 *   → "arn:aws:iam::<account-id-redacted>:role/LambdaExec"  (role/ allowlisted)
 *
 *   "arn:aws:s3:::sensitive-customer-bucket-12345"
 *   → "arn:aws:s3:::<resource-redacted>"  (S3 resource redacted; no account ID in S3 ARNs)
 *
 *   Non-ARN strings pass through unchanged.
 */
export function redactArn(input: string): string {
  if (!input || !input.startsWith("arn:")) return input;
  return input.replace(
    ARN_PATTERN,
    (
      _match,
      partition: string,
      service: string,
      region: string,
      accountFull: string,
      accountDigits: string | undefined,
      _colonResource: string | undefined,
      resource: string | undefined,
    ) => {
      const redactedAccount = accountDigits ? REDACTED_ACCOUNT_ID : accountFull; // keep empty string for services like S3
      const resourceSuffix =
        resource !== undefined ? `:${redactResource(resource)}` : "";
      return `arn:${partition}:${service}:${region}:${redactedAccount}${resourceSuffix}`;
    },
  );
}

/**
 * Redact the resource portion of an ARN based on the allowlist.
 * If the resource starts with an allowlisted prefix, the prefix is kept
 * but the trailing name/path is redacted to preserve type signal.
 * Otherwise the entire resource is replaced.
 */
function redactResource(resource: string): string {
  if (!resource) return REDACTED_RESOURCE;
  for (const prefix of RESOURCE_ALLOWLIST_PREFIXES) {
    if (resource.toLowerCase().startsWith(prefix)) {
      // Keep the type prefix; redact the name that follows
      return `${resource.slice(0, prefix.length)}${REDACTED_RESOURCE}`;
    }
  }
  return REDACTED_RESOURCE;
}

/**
 * Scan a free-form text string (e.g. an LLM prompt or error message) and
 * redact every ARN found within it. Non-ARN content is preserved verbatim.
 *
 * Use this at LLM prompt-build time to scrub any ARNs embedded in
 * user-supplied intent strings, error messages, or memory hints before
 * they reach the model.
 */
export function redactArnsInString(text: string): string {
  if (!text) return text;
  return text.replace(
    ARN_PATTERN,
    (
      _match,
      partition: string,
      service: string,
      region: string,
      accountFull: string,
      accountDigits: string | undefined,
      _colonResource: string | undefined,
      resource: string | undefined,
    ) => {
      const redactedAccount = accountDigits ? REDACTED_ACCOUNT_ID : accountFull;
      const resourceSuffix =
        resource !== undefined ? `:${redactResource(resource)}` : "";
      return `arn:${partition}:${service}:${region}:${redactedAccount}${resourceSuffix}`;
    },
  );
}
