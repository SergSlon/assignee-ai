/**
 * Skeletal-plan detector (e98.W5.N5 — C-N3 + C-N4 + C-P3).
 *
 * A "skeletal plan" is a desiredState that CloudControl will reject
 * at apply time because a required-by-service field is an empty array.
 * Three known incarnations from the Epic 97 findings:
 *
 *   - C-N3 HIGH RDS: `VPCSecurityGroups: []` and/or missing
 *     `DBSubnetGroupName` produce a plan that looks complete but AWS
 *     rejects with `InvalidParameterValue: The parameter
 *     VPCSecurityGroups must have at least 1 entry`.
 *   - C-N4 LOW ALB: `Subnets: []` and/or `SecurityGroups: []` on an
 *     Application Load Balancer plan produces the same class of
 *     apply-time failure — `ValidationError: At least one subnet
 *     must be specified`.
 *   - C-P3 LOW RDS DBSubnetGroup: `SubnetIds: []` on a DBSubnetGroup
 *     plan fails apply with the analogous CloudControl error.
 *
 * Pre-W5.N5 the plan-generator emitted these as `provisionable: true`
 * with zero signal to the user that the plan was skeletal; apply would
 * race through to CloudControl and surface the raw AWS error from a
 * very different vocabulary than the intent-parser / BP / preflight
 * layers. The user had no pre-apply diagnostic.
 *
 * This detector scans a `desiredState` for the known skeletal shapes
 * and returns two outputs:
 *
 *   - `emptyFields: string[]` — the dotted paths of the empty
 *     required arrays (e.g. `VPCSecurityGroups`, `Subnets`,
 *     `SubnetIds`). Consumers use this to decide whether to flip
 *     `provisionable: false` on the plan entry.
 *   - `advisories: Advisory[]` — structured diagnostics the CLI
 *     result-formatter surfaces to the user with a remediation hint
 *     (`--set <Field>=<value>` or route through a compound pattern).
 *
 * The detector is scoped by resourceType — each type has its own
 * short list of required-by-service array fields. Adding a new type
 * means extending `REQUIRED_NONEMPTY_ARRAYS_BY_TYPE` below; the
 * generic walk handles the rest.
 *
 * The list stays conservative (explicit allowlist per type, not
 * "flag every empty array in the plan") because CFN schemas have
 * plenty of legitimately-empty arrays (e.g. `Tags: []` on a fresh
 * S3 bucket). An over-broad detector would spam advisories and erode
 * trust.
 */

import { RESOURCE_TYPES } from "../../../config/resource-types.js";
import type { Advisory } from "../intent-parser.js";

/**
 * Required-by-service array field names, keyed by CFN resource type.
 * Each entry is a flat top-level path — nested empty arrays are NOT
 * inspected (the AWS docs rarely require nested arrays to be non-
 * empty at create time).
 *
 * To extend: add a `[RESOURCE_TYPES.FOO]: ["Bar", "Baz"]` line with
 * the AWS-documented required-not-empty fields for the type, then
 * add a `detector-skeletal-plan.test.ts` case that exercises the new
 * entry. See the test file for the established pattern.
 */
const REQUIRED_NONEMPTY_ARRAYS_BY_TYPE: Readonly<
  Record<string, readonly string[]>
> = {
  // C-N3 — RDS DBInstance is skeletal without at least one SG AND a
  // subnet group name. `DBSubnetGroupName` is a string (not an
  // array) but its absence has the same class of apply-time failure;
  // callers using `getEmptyStringFields` fill that gap. Here we list
  // the array-valued required fields only.
  [RESOURCE_TYPES.RDS_DB_INSTANCE]: ["VPCSecurityGroups"],

  // C-N4 — ALB requires both Subnets (spanning 2+ AZs) and
  // SecurityGroups (ALB only — NLB does NOT take SGs). The detector
  // flags both as empty; the advisory text explains the 2-AZ rule.
  [RESOURCE_TYPES.ELBV2_LOAD_BALANCER]: ["Subnets", "SecurityGroups"],

  // C-P3 — DBSubnetGroup requires at least one SubnetId.
  [RESOURCE_TYPES.RDS_DB_SUBNET_GROUP]: ["SubnetIds"],
};

/**
 * String fields whose absence (undefined/empty) makes the plan
 * skeletal. These are string-typed in the CFN schema but have the
 * same "apply will fail" outcome as the empty-array cases. Kept
 * separate so the public detector function has a clean signature.
 */
const REQUIRED_NONEMPTY_STRINGS_BY_TYPE: Readonly<
  Record<string, readonly string[]>
> = {
  // C-N3 — missing DBSubnetGroupName on a VPC-attached RDS plan.
  [RESOURCE_TYPES.RDS_DB_INSTANCE]: ["DBSubnetGroupName"],
};

/**
 * Public result shape. `emptyFields` is a sorted union of empty
 * arrays and missing strings; `advisories` has one entry per
 * detected gap so the CLI can surface each individually.
 */
export interface SkeletalPlanDetection {
  readonly emptyFields: readonly string[];
  readonly advisories: readonly Advisory[];
  /**
   * True when the detector found at least one empty required field.
   * Consumers flip `provisionable: false` on the corresponding plan
   * entry when this is true.
   */
  readonly isSkeletal: boolean;
}

/**
 * Inspect a `desiredState` for skeletal-plan indicators specific to
 * the given resourceType. Returns `{isSkeletal: false, …}` cleanly
 * when the type is not in the allowlist, or when no required-field
 * gap is found.
 *
 * Pure function — no external state, no logs. Deterministic given
 * identical inputs.
 */
export function detectSkeletalPlan(
  resourceType: string,
  desiredState: Record<string, unknown>,
): SkeletalPlanDetection {
  const arrayFields = REQUIRED_NONEMPTY_ARRAYS_BY_TYPE[resourceType] ?? [];
  const stringFields = REQUIRED_NONEMPTY_STRINGS_BY_TYPE[resourceType] ?? [];

  const emptyFields: string[] = [];
  const advisories: Advisory[] = [];

  for (const fieldName of arrayFields) {
    const value = desiredState[fieldName];
    if (isEmptyArray(value)) {
      emptyFields.push(fieldName);
      advisories.push(buildAdvisoryForEmptyArray(resourceType, fieldName));
    }
  }

  for (const fieldName of stringFields) {
    const value = desiredState[fieldName];
    if (isEmptyString(value)) {
      emptyFields.push(fieldName);
      advisories.push(buildAdvisoryForMissingString(resourceType, fieldName));
    }
  }

  return {
    emptyFields,
    advisories,
    isSkeletal: emptyFields.length > 0,
  };
}

function isEmptyArray(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  // Defensive — a non-array value on a required-array field is still
  // apply-failing drift. Flagging here surfaces a clearer diagnostic
  // than the CloudControl error would.
  return true;
}

function isEmptyString(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value.trim() === "";
}

/**
 * Build the per-field advisory. Each field has a bespoke hint that
 * names the `--set` flag the user should supply OR the compound
 * pattern that wires the field automatically. The advisory `code`
 * is stable across versions so downstream consumers can grep.
 */
function buildAdvisoryForEmptyArray(
  resourceType: string,
  fieldName: string,
): Advisory {
  const { message, hint } = ADVISORY_TEXTS[`${resourceType}:${fieldName}`] ?? {
    message: `${resourceType} plan has empty "${fieldName}"; apply will fail.`,
    hint: `Populate --set ${fieldName}=<value> before apply, or route through a compound pattern that wires ${fieldName} automatically.`,
  };
  return {
    code: "PLAN_SKELETAL",
    message,
    hint,
    details: { resourceType, field: fieldName, kind: "empty-array" },
  };
}

function buildAdvisoryForMissingString(
  resourceType: string,
  fieldName: string,
): Advisory {
  const { message, hint } = ADVISORY_TEXTS[`${resourceType}:${fieldName}`] ?? {
    message: `${resourceType} plan is missing required "${fieldName}"; apply will fail.`,
    hint: `Populate --set ${fieldName}=<value> before apply, or route through a compound pattern that wires ${fieldName} automatically.`,
  };
  return {
    code: "PLAN_SKELETAL",
    message,
    hint,
    details: { resourceType, field: fieldName, kind: "missing-string" },
  };
}

/**
 * Per-field advisory overrides with operationally-specific hints.
 * Keys use `<resourceType>:<fieldName>` syntax.
 */
const ADVISORY_TEXTS: Readonly<
  Record<string, { message: string; hint: string }>
> = {
  [`${RESOURCE_TYPES.RDS_DB_INSTANCE}:VPCSecurityGroups`]: {
    message:
      "RDS DB instance plan has empty VPCSecurityGroups; apply will fail with `must have at least 1 entry`.",
    hint: "Add --set VPCSecurityGroups=<sg-id> pointing at a security group that allows ingress on the DB port, or route through the `rds-with-vpc` compound which wires an engine-aware SG automatically.",
  },
  [`${RESOURCE_TYPES.RDS_DB_INSTANCE}:DBSubnetGroupName`]: {
    message:
      "RDS DB instance plan is missing DBSubnetGroupName; a VPC-attached DB requires it or it defaults to the unusable `default` group.",
    hint: "Add --set DBSubnetGroupName=<group-name>, or route through the `three-tier-web` / `rds-with-vpc` compound which creates the subnet group inline.",
  },
  [`${RESOURCE_TYPES.ELBV2_LOAD_BALANCER}:Subnets`]: {
    message:
      "ALB plan has empty Subnets; CFN requires at least 2 subnets spanning 2 Availability Zones before apply.",
    hint: "Add --set Subnets=<subnet-a>,<subnet-b> for 2 AZs, or route through the `three-tier-web` compound which wires public subnets automatically.",
  },
  [`${RESOURCE_TYPES.ELBV2_LOAD_BALANCER}:SecurityGroups`]: {
    message:
      "ALB plan has empty SecurityGroups; Application Load Balancers require at least one SG (Network Load Balancers do not).",
    hint: "Add --set SecurityGroups=<sg-id>, or route through the `three-tier-web` compound which creates an HTTP(S) SG for you.",
  },
  [`${RESOURCE_TYPES.RDS_DB_SUBNET_GROUP}:SubnetIds`]: {
    message:
      "RDS DBSubnetGroup plan has empty SubnetIds; at least two subnets in different AZs are required.",
    hint: "Add --set SubnetIds=<subnet-a>,<subnet-b>, or route through the `three-tier-web` compound which provisions the subnets inline.",
  },
};
