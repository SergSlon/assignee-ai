/**
 * Marker tokens for compound-pattern cross-references.
 *
 * CloudControl API takes a flat property bag — it does NOT process CloudFormation
 * intrinsics like `{Ref: X}` or `{Fn::GetAZs: ""}`. Compound patterns therefore
 * cannot use those intrinsics directly in `defaultOptions` because the values
 * would reach CloudControl unresolved and provisioning would fail.
 *
 * Instead, patterns emit concrete string MARKERS like:
 *   "__ASSIGNEE_REF_vpc__"          — physical ID of another compound resource
 *   "__ASSIGNEE_AZ_0__"             — first AZ in the target region
 *
 * The plan-generator's compound branch walks the generated `desiredState` and
 * substitutes each marker with the real value (looked up from
 * `state.completedResources` or `EC2:DescribeAvailabilityZones`) before the
 * plan is handed to CloudControl.
 *
 * Keep this module free of AWS SDK dependencies — it is consumed by the
 * pattern-template source files that run in pure config contexts (no runtime).
 */

/** Common prefix for all assignee.ai marker tokens. */
export const MARKER_PREFIX = "__ASSIGNEE_" as const;
/** Suffix that closes every marker token. */
export const MARKER_SUFFIX = "__" as const;

/**
 * Builds a marker that references another compound resource by its logical
 * `resourceId`. At resolution time the marker is replaced with the physical
 * identifier that CloudControl returned for the prior step
 * (e.g. `vpc-0abc123`, `subnet-0def456`, `igw-0789abc`, `eipalloc-012xyz`).
 */
export function markerRef(resourceId: string): string {
  if (!resourceId) {
    throw new Error("markerRef: resourceId must be non-empty");
  }
  return `${MARKER_PREFIX}REF_${resourceId}${MARKER_SUFFIX}`;
}

/**
 * Builds a marker that references a GetAtt-style attribute of another
 * compound resource. Currently resolved identically to `markerRef` because
 * CloudControl returns the single primary identifier — extend this helper if
 * per-attribute resolution is ever needed.
 */
export function markerGetAtt(resourceId: string, attribute: string): string {
  if (!resourceId || !attribute) {
    throw new Error("markerGetAtt: resourceId and attribute must be non-empty");
  }
  // `parseMarker` uses `lastIndexOf("_")` to split resourceId from
  // attribute, which means the attribute segment must not contain
  // underscores — otherwise the round-trip silently slices the attribute
  // name. Pin this invariant at construction time so a future pattern
  // that emits (e.g.) "Access_Key" fails loudly instead of producing an
  // unresolvable marker at apply time.
  if (attribute.includes("_")) {
    throw new Error(
      `markerGetAtt: attribute must not contain '_' (parser splits on lastIndexOf). Got ${attribute}`,
    );
  }
  return `${MARKER_PREFIX}GETATT_${resourceId}_${attribute}${MARKER_SUFFIX}`;
}

/**
 * Builds a marker that references the Nth availability zone in the target
 * region. The resolver calls `EC2:DescribeAvailabilityZones` once per plan
 * generation and caches the sorted AZ name list.
 */
export function markerAz(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(
      `markerAz: index must be a non-negative integer, got ${index}`,
    );
  }
  return `${MARKER_PREFIX}AZ_${index}${MARKER_SUFFIX}`;
}

/**
 * Builds a marker that resolves to the AWS region at apply time
 * (e.g. "us-east-1"). Used in S3 origin DomainName for CloudFront
 * where the regional endpoint resolves immediately for new buckets,
 * unlike the global `.s3.amazonaws.com` which can lag by minutes.
 */
export function markerRegion(): string {
  return `${MARKER_PREFIX}REGION${MARKER_SUFFIX}`;
}

/**
 * Builds a marker that resolves to the **bare primary identifier** of a
 * compound resource — NOT the ARN. `markerRef` returns the full ARN
 * (because `completedResources[].resourceArn` is pre-synthesized by
 * `buildResourceArn`), which is correct for fields like `aws:SourceArn`
 * and any IAM Resource clause, but WRONG for the handful of CloudControl
 * properties that require the bare identifier.
 *
 * Known bare-identifier call-sites:
 *   - `AWS::S3::BucketPolicy.Bucket`     — must be the bucket NAME, not ARN
 *   - future resources that cross-reference their parent's name directly
 *
 * At resolve time the token `__ASSIGNEE_IDENTIFIER_<resourceId>__` is
 * replaced by `extractIdentifierFromArn(completedResources[].resourceArn,
 * resourceType)` which strips the ARN prefix and returns the bare name
 * (partition-aware via the existing arn-helpers table).
 *
 * Choose `markerRef` for ARN fields; choose `markerIdentifier` for
 * bare-name fields. If a property's spec is ambiguous, check the
 * CloudFormation schema for the target resource type — it will say
 * either "Type: string — the bucket name" (→ use `markerIdentifier`)
 * or "Type: string — the ARN" (→ use `markerRef`).
 */
export function markerIdentifier(resourceId: string): string {
  if (!resourceId) {
    throw new Error("markerIdentifier: resourceId must be non-empty");
  }
  return `${MARKER_PREFIX}IDENTIFIER_${resourceId}${MARKER_SUFFIX}`;
}

/**
 * Builds a marker that resolves to the calling operator's AWS account ID
 * at apply time (12 digits, e.g. "210987654321"). Compound patterns need
 * this when they construct ARNs for resources whose CCAPI `identifier`
 * is NOT the full ARN — e.g. `AWS::CloudFront::Distribution` returns the
 * bare distribution ID, so to produce a valid `aws:SourceArn` condition
 * value the template must manually build
 * `arn:aws:cloudfront::<account>:distribution/<id>` — and the `<account>`
 * slot is this marker.
 *
 * The resolver calls `sts:GetCallerIdentity` once per plan (cached for
 * the process lifetime) using operator credentials.
 */
export function markerAccountId(): string {
  return `${MARKER_PREFIX}ACCOUNT_ID${MARKER_SUFFIX}`;
}

/**
 * Matches any assignee.ai marker token — used for bare-string detection.
 *
 * Two disjoint branches to avoid the multi-marker lazy-suffix bug:
 *   - `(REF|GETATT|AZ|IDENTIFIER)` kinds ALWAYS have a suffix like
 *     `_<resourceId>` or `_<n>`, so they require `_[^\s]*?__`.
 *   - `(REGION|ACCOUNT_ID)` kinds have NO suffix — directly followed by
 *     the closing `__`. Without this split, a lazy `_?[^\s]*?__` after
 *     `ACCOUNT_ID` would eat characters up to the FIRST `__` anywhere in
 *     the string, which for templates like
 *     `arn:aws:cloudfront::__ASSIGNEE_ACCOUNT_ID__:distribution/__ASSIGNEE_REF_x__`
 *     produced a malformed combined token
 *     `__ASSIGNEE_ACCOUNT_ID_:distribution/__` that parseMarker rejected,
 *     so the ACCOUNT_ID stayed unresolved. Closed in Epic 88-it3.
 */
export const MARKER_PATTERN =
  /__ASSIGNEE_(?:(?:REF|GETATT|AZ|IDENTIFIER)_[^\s]*?__|(?:REGION|ACCOUNT_ID)__)/;

/**
 * Global-flag variant of {@link MARKER_PATTERN} — used by plan-generator's
 * `resolveValue` and `resolveString` to find every marker embedded in a
 * longer string (e.g. `"<bucket>.s3.__ASSIGNEE_REGION__.amazonaws.com"`).
 * Exported so the two call sites share a single source of truth; prior
 * code duplicated the regex literal, which meant a tightening fix had to
 * land in both places or risk drift.
 */
export const MARKER_PATTERN_GLOBAL =
  /__ASSIGNEE_(?:(?:REF|GETATT|AZ|IDENTIFIER)_[^\s]*?__|(?:REGION|ACCOUNT_ID)__)/g;

/**
 * Parses a marker string into its structured components.
 * Returns `undefined` when the value is not a recognised marker.
 */
export type ParsedMarker =
  | { kind: "ref"; resourceId: string }
  | { kind: "getatt"; resourceId: string; attribute: string }
  | { kind: "identifier"; resourceId: string }
  | { kind: "az"; index: number }
  | { kind: "region" }
  | { kind: "account-id" };

export function parseMarker(value: unknown): ParsedMarker | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith(MARKER_PREFIX) || !value.endsWith(MARKER_SUFFIX)) {
    return undefined;
  }
  const inner = value.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length);
  // REF_<id>
  if (inner.startsWith("REF_")) {
    const resourceId = inner.slice("REF_".length);
    if (!resourceId) return undefined;
    return { kind: "ref", resourceId };
  }
  // IDENTIFIER_<id>
  if (inner.startsWith("IDENTIFIER_")) {
    const resourceId = inner.slice("IDENTIFIER_".length);
    if (!resourceId) return undefined;
    return { kind: "identifier", resourceId };
  }
  // GETATT_<id>_<attr>
  if (inner.startsWith("GETATT_")) {
    const rest = inner.slice("GETATT_".length);
    const lastUnderscore = rest.lastIndexOf("_");
    if (lastUnderscore <= 0) return undefined;
    const resourceId = rest.slice(0, lastUnderscore);
    const attribute = rest.slice(lastUnderscore + 1);
    if (!resourceId || !attribute) return undefined;
    return { kind: "getatt", resourceId, attribute };
  }
  // ACCOUNT_ID
  if (inner === "ACCOUNT_ID") {
    return { kind: "account-id" };
  }
  // AZ_<n>
  if (inner.startsWith("AZ_")) {
    const indexStr = inner.slice("AZ_".length);
    const index = Number.parseInt(indexStr, 10);
    if (!Number.isInteger(index) || index < 0) return undefined;
    return { kind: "az", index };
  }
  // REGION (no suffix — just the bare token)
  if (inner === "REGION") {
    return { kind: "region" };
  }
  return undefined;
}

/** Convenience: true if any string within `value` is a marker token. */
export function isMarker(value: unknown): boolean {
  return parseMarker(value) !== undefined;
}
