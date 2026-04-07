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

/** Matches any assignee.ai marker token — used for detection. */
export const MARKER_PATTERN = /__ASSIGNEE_(REF|GETATT|AZ)_[^\s]+?__/;

/**
 * Parses a marker string into its structured components.
 * Returns `undefined` when the value is not a recognised marker.
 */
export type ParsedMarker =
  | { kind: "ref"; resourceId: string }
  | { kind: "getatt"; resourceId: string; attribute: string }
  | { kind: "az"; index: number };

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
  // AZ_<n>
  if (inner.startsWith("AZ_")) {
    const indexStr = inner.slice("AZ_".length);
    const index = Number.parseInt(indexStr, 10);
    if (!Number.isInteger(index) || index < 0) return undefined;
    return { kind: "az", index };
  }
  return undefined;
}

/** Convenience: true if any string within `value` is a marker token. */
export function isMarker(value: unknown): boolean {
  return parseMarker(value) !== undefined;
}
