/**
 * Dispatch-table classifier for CCAPI `createResource` failures.
 *
 * Story 53-it1-12: prior to this refactor, the main orchestrator in
 * `resource-provisioner.ts` walked the same `createErr.kind` axis three
 * times to compute (a) the user-facing message prefix, (b) the
 * `PROVISIONING_ERROR_CODES` category, and (c) the short message embedded
 * inside the thrown `ProvisioningError`. That nested-ternary triple-walk
 * was L7 HIGH H4 on the complexity audit.
 *
 * The replacement is a single dispatch table keyed by
 * `ProvisioningErrorKind` plus a resource-type-aware override for the S3
 * "bucket name already taken globally" special case. Every new kind that
 * lands in the `ProvisioningErrorKind` enum MUST add an entry here —
 * TypeScript exhaustiveness (`Record<ProvisioningErrorKindType, …>`)
 * enforces that at compile time.
 *
 * SRP: pure classification, no I/O, no cleanup, no state mutation.
 */

import { PROVISIONING_ERROR_CODES } from "@/errors.js";
import type { ProvisioningErrorCode } from "@/errors.js";
import {
  ProvisioningErrorKind,
  type ProvisioningErrorKindType,
  type ProvisioningPortError,
} from "@/ports/provisioning-port.js";

/**
 * Axes of the per-error-kind dispatch table.
 *
 * - `userPrefix`: leading sentence embedded in the user-facing
 *   `errorMessage` after "CloudControl provisioning failed: …". May use
 *   the raw adapter message as a dynamic fallback for unknown kinds.
 * - `errorCode`: the `PROVISIONING_ERROR_CODES` bucket that downstream
 *   hint-registry / result-formatter branches on.
 * - `shortMessage`: the headline message fed into the thrown
 *   `ProvisioningError(...)` so reducers + logs see a stable phrase.
 */
export interface ProvisioningErrorDescriptor {
  readonly errorCode: ProvisioningErrorCode;
  readonly userPrefix: (
    rawMessage: string,
    resourceType: string | undefined,
  ) => string;
  readonly shortMessage: (rawMessage: string) => string;
}

/**
 * Resource-type-aware override for `ALREADY_EXISTS` on S3 buckets. The
 * S3 global-namespace collision is the #1 user confusion point because
 * a bucket name may be globally unique even though the caller's account
 * has never heard of it. The friendlier message mentions the global
 * namespace explicitly.
 */
const S3_BUCKET_ALREADY_EXISTS_PREFIX =
  "S3 bucket name is already taken globally. Choose a different name.";

const ALREADY_EXISTS_PREFIX =
  "Resource already exists. Choose a different name.";

const THROTTLED_PREFIX = "Request throttled by AWS. Please wait and retry.";

/**
 * Substring that CCAPI embeds when AttributeDefinitions contains entries
 * not referenced by any KeySchema (table-level, GSI, or LSI). This
 * happens when the LLM adds TTL-target attributes to AttributeDefinitions
 * — AWS rejects them because TTL attrs must NOT appear there.
 *
 * The sanitizer (desired-state-sanitizer.ts Rule 3) strips these
 * automatically on the next run; the hint below tells the user why their
 * current plan was rejected and what to do.
 */
const DDB_ATTR_DEFS_MISMATCH_SUBSTRING =
  "number of attributes in keyschema does not exactly match number of attributes defined in attributedefinitions";

const DDB_ATTR_DEFS_HINT =
  "DynamoDB AttributeDefinitions must only contain attributes used in KeySchema, GlobalSecondaryIndexes, or LocalSecondaryIndexes. " +
  "Attributes referenced by TTL, indexes-without-keys, or unrelated metadata must not appear here. " +
  "Re-run the intent; the sanitizer should now drop those extra entries automatically.";

/**
 * DF-A4-partial / DF-D5 / DF-DDB-TTL-IAM-MISSING (live dogfood 2026-05-11):
 * AWS returns "is not authorized to perform" when the operator's
 * attached IAM policy lacks an action that the apply flow requires.
 * Two distinct sub-causes:
 *
 *   1. The action is missing from the operator policy IN CODE (true
 *      gap — needs a code change to add to iam-actions/*.ts). Example:
 *      `dynamodb:UpdateTimeToLive` until the fix that ships alongside
 *      this hint.
 *
 *   2. The action is in CODE but the user's attached AWS policy is an
 *      OLDER version that predates it. `assignee dev setup` re-runs the
 *      `ensurePolicy()` helper which calls `CreatePolicyVersion` to
 *      refresh the policy in-place — no user-or-role recreation needed.
 *      Example: `iam:CreateRole` (in code since Story 50-5 but absent
 *      from operator users provisioned earlier).
 *
 * The hint covers both — re-run setup first, file an issue if that
 * doesn't fix it (then it's case 1).
 */
const NOT_AUTHORIZED_SUBSTRING = "is not authorized to perform";

const NOT_AUTHORIZED_HINT =
  "AWS denied the action because the operator IAM policy lacks the permission. " +
  "Most often this means the operator user was provisioned by an older version of assignee; " +
  "run `assignee dev setup` to refresh the operator policy via CreatePolicyVersion (no user recreation needed). " +
  "If the error persists after re-running setup, the action is missing from the codebase — " +
  "file an issue with the AWS message below. " +
  "Run `assignee admin audit-verify` to see required IAM actions for this resource type.";

/**
 * DF-A4/D6 (live dogfood 2026-05-11): PERMISSION_DENIED / AccessDeniedException
 * from CloudControl API was surfacing as the raw unhandled error string
 * ("An unclassified error was encountered. This may be a bug") because
 * ACCESS_DENIED kind mapped to PROVISIONING_ERROR_CODES.UNKNOWN instead of
 * PROVISIONING_ERROR_CODES.ACCESS_DENIED.
 *
 * Fix: any raw AWS message that contains "AccessDeniedException", "Access Denied",
 * or "PERMISSION_DENIED" is enriched with an actionable hint that names
 * `assignee admin audit-verify` as the diagnostic tool.
 *
 * Note: "is not authorized to perform" messages are handled by
 * NOT_AUTHORIZED_SUBSTRING above (those come through multiple ProvisioningErrorKinds
 * depending on which SDK pathway hit them). This handler covers the pure CCAPI
 * permission-denied class that arrives explicitly as ACCESS_DENIED kind with
 * an AWS AccessDeniedException payload.
 */
const PERMISSION_DENIED_SUBSTRINGS = [
  "accessdeniedexception",
  "access denied",
  "permission_denied",
  "is not authorized to perform",
] as const;

const PERMISSION_DENIED_HINT =
  "CloudControl API returned a permission denied error. " +
  "Check your operator role's permissions for this resource type. " +
  "Run `assignee admin audit-verify` to list the required IAM actions and identify what is missing. " +
  "Then run `assignee dev setup` to refresh the operator policy via CreatePolicyVersion (no user recreation needed).";

/**
 * Shared base for ALREADY_EXISTS / THROTTLED / UNKNOWN (and any future
 * kinds we add) — promotes a string literal prefix to a dispatch entry.
 */
function staticEntry(
  errorCode: ProvisioningErrorCode,
  prefix: string,
  shortMessage: string,
): ProvisioningErrorDescriptor {
  return {
    errorCode,
    userPrefix: () => prefix,
    shortMessage: () => shortMessage,
  };
}

/**
 * Returns true when the raw AWS error message indicates a permission-denied
 * class of error (covers CCAPI AccessDeniedException, "is not authorized to
 * perform", and bare "PERMISSION_DENIED" strings).
 *
 * Used by both enrichers AND the ACCESS_DENIED dispatch entry to decide
 * whether to surface the PERMISSION_DENIED_HINT.
 */
function isPermissionDeniedMessage(lower: string): boolean {
  return PERMISSION_DENIED_SUBSTRINGS.some((s) => lower.includes(s));
}

/**
 * Apply registered substring → hint mappings to a raw AWS error
 * message. Returns the enriched string if any pattern matches, or the
 * raw string unchanged otherwise. Centralised here so every dispatch
 * branch that surfaces a raw AWS message gets the same enrichments —
 * AWS reports the same logical error under different kinds depending
 * on which SDK pathway hit it, and we don't want classification noise
 * to suppress an actionable hint.
 */
function enrichForUserPrefix(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes(DDB_ATTR_DEFS_MISMATCH_SUBSTRING)) {
    return `${DDB_ATTR_DEFS_HINT}\n\nAWS message: ${raw}`;
  }
  if (lower.includes(NOT_AUTHORIZED_SUBSTRING)) {
    return `${NOT_AUTHORIZED_HINT}\n\nAWS message: ${raw}`;
  }
  return raw;
}

function enrichForShortMessage(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes(DDB_ATTR_DEFS_MISMATCH_SUBSTRING)) {
    return `${DDB_ATTR_DEFS_HINT} (raw: ${raw})`;
  }
  if (lower.includes(NOT_AUTHORIZED_SUBSTRING)) {
    return `${NOT_AUTHORIZED_HINT} (raw: ${raw})`;
  }
  return raw;
}

/**
 * Enricher for the ACCESS_DENIED dispatch branch. Unlike the generic
 * enrichers above (which handle UNKNOWN-mapped kinds), this one is
 * called ONLY when the ProvisioningErrorKind is explicitly ACCESS_DENIED.
 * It always returns the PERMISSION_DENIED_HINT + raw message — because
 * if CCAPI classified the error as ACCESS_DENIED, it IS a permission issue.
 *
 * DF-A4/D6 fix: this ensures `ACCESS_DENIED` kind messages surface the
 * `assignee admin audit-verify` hint AND are classified with
 * PROVISIONING_ERROR_CODES.ACCESS_DENIED (not UNKNOWN).
 */
function enrichAccessDeniedForUserPrefix(raw: string): string {
  const lower = raw.toLowerCase();
  // If it matches a more specific pattern (DDB attr-defs or not-authorized),
  // use that more specific enrichment first — those already include the
  // `assignee dev setup` hint which is equally actionable.
  if (lower.includes(DDB_ATTR_DEFS_MISMATCH_SUBSTRING)) {
    return `${DDB_ATTR_DEFS_HINT}\n\nAWS message: ${raw}`;
  }
  if (lower.includes(NOT_AUTHORIZED_SUBSTRING)) {
    return `${NOT_AUTHORIZED_HINT}\n\nAWS message: ${raw}`;
  }
  // Pure CCAPI AccessDeniedException / PERMISSION_DENIED pathway.
  return `${PERMISSION_DENIED_HINT}\n\nAWS message: ${raw}`;
}

function enrichAccessDeniedForShortMessage(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes(DDB_ATTR_DEFS_MISMATCH_SUBSTRING)) {
    return `${DDB_ATTR_DEFS_HINT} (raw: ${raw})`;
  }
  if (lower.includes(NOT_AUTHORIZED_SUBSTRING)) {
    return `${NOT_AUTHORIZED_HINT} (raw: ${raw})`;
  }
  return `${PERMISSION_DENIED_HINT} (raw: ${raw})`;
}

/**
 * DF-A4/D6: Returns true when the ACCESS_DENIED error message is a pure
 * "access denied" variant (not "not authorized to perform" which is
 * separately handled). Used by tests to verify the routing decision.
 * Exported for unit tests only.
 */
export function isRawAccessDeniedMessage(raw: string): boolean {
  const lower = raw.toLowerCase();
  return (
    isPermissionDeniedMessage(lower) &&
    !lower.includes(NOT_AUTHORIZED_SUBSTRING)
  );
}

/**
 * Dispatch table. The `Record<ProvisioningErrorKindType, …>` type forces
 * every enum variant to have an entry — if the enum grows, TypeScript
 * will fail the build here until a new row is added.
 */
const ERROR_DISPATCH: Record<
  ProvisioningErrorKindType,
  ProvisioningErrorDescriptor
> = {
  [ProvisioningErrorKind.ALREADY_EXISTS]: {
    errorCode: PROVISIONING_ERROR_CODES.ALREADY_EXISTS,
    userPrefix: (_raw, resourceType) =>
      resourceType === "AWS::S3::Bucket"
        ? S3_BUCKET_ALREADY_EXISTS_PREFIX
        : ALREADY_EXISTS_PREFIX,
    shortMessage: () => "Resource already exists",
  },
  [ProvisioningErrorKind.THROTTLED]: staticEntry(
    PROVISIONING_ERROR_CODES.THROTTLED,
    THROTTLED_PREFIX,
    "Request throttled by AWS",
  ),
  // Remaining kinds all fall through to UNKNOWN semantics: surface the
  // adapter's raw message verbatim (with enrichments for known
  // patterns — see enrichForUserPrefix/enrichForShortMessage above) so
  // the user sees the underlying AWS reason (e.g. "Unable to locate
  // credentials.", "AccessDenied: User: arn:aws:iam::…").
  //
  // Same enricher applied to ALL UNKNOWN branches: AWS reports the
  // same logical error under different ProvisioningErrorKinds
  // depending on which SDK pathway hit it (the DDB UpdateTimeToLive
  // "not authorized" today surfaced as SERVICE_ERROR, but the Lambda
  // iam:CreateRole "not authorized" comes through as ACCESS_DENIED).
  // Routing the hint through one helper keeps them in sync.
  [ProvisioningErrorKind.NOT_FOUND]: {
    errorCode: PROVISIONING_ERROR_CODES.UNKNOWN,
    userPrefix: enrichForUserPrefix,
    shortMessage: enrichForShortMessage,
  },
  // DF-A4/D6 fix: ACCESS_DENIED kind now maps to
  // PROVISIONING_ERROR_CODES.ACCESS_DENIED (was UNKNOWN) so downstream
  // hint-registry / result-formatter branches see a distinct error code.
  // The enricher surfaces the `assignee admin audit-verify` hint + raw message.
  [ProvisioningErrorKind.ACCESS_DENIED]: {
    errorCode: PROVISIONING_ERROR_CODES.ACCESS_DENIED,
    userPrefix: enrichAccessDeniedForUserPrefix,
    shortMessage: enrichAccessDeniedForShortMessage,
  },
  [ProvisioningErrorKind.SERVICE_ERROR]: {
    errorCode: PROVISIONING_ERROR_CODES.UNKNOWN,
    userPrefix: enrichForUserPrefix,
    shortMessage: enrichForShortMessage,
  },
  [ProvisioningErrorKind.UNKNOWN]: {
    errorCode: PROVISIONING_ERROR_CODES.UNKNOWN,
    userPrefix: enrichForUserPrefix,
    shortMessage: enrichForShortMessage,
  },
};

/**
 * Resolve a `ProvisioningPortError` into the three axes needed by the
 * orchestrator — all via one dispatch-table lookup.
 */
export interface ClassifiedCreateError {
  readonly errorCode: ProvisioningErrorCode;
  readonly userPrefix: string;
  readonly shortMessage: string;
}

export function classifyCreateError(
  createErr: ProvisioningPortError,
  resourceType: string | undefined,
): ClassifiedCreateError {
  const descriptor =
    ERROR_DISPATCH[createErr.kind] ??
    ERROR_DISPATCH[ProvisioningErrorKind.UNKNOWN];
  return {
    errorCode: descriptor.errorCode,
    userPrefix: descriptor.userPrefix(createErr.message, resourceType),
    shortMessage: descriptor.shortMessage(createErr.message),
  };
}
