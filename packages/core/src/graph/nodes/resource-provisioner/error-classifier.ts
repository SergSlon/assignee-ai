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
  // adapter's raw message verbatim so the user sees the underlying AWS
  // reason (e.g. "Unable to locate credentials.", "AccessDenied:
  // User: arn:aws:iam::…").
  [ProvisioningErrorKind.NOT_FOUND]: {
    errorCode: PROVISIONING_ERROR_CODES.UNKNOWN,
    userPrefix: (raw) => raw,
    shortMessage: (raw) => raw,
  },
  [ProvisioningErrorKind.ACCESS_DENIED]: {
    errorCode: PROVISIONING_ERROR_CODES.UNKNOWN,
    userPrefix: (raw) => raw,
    shortMessage: (raw) => raw,
  },
  [ProvisioningErrorKind.SERVICE_ERROR]: {
    errorCode: PROVISIONING_ERROR_CODES.UNKNOWN,
    userPrefix: (raw) => {
      if (raw.toLowerCase().includes(DDB_ATTR_DEFS_MISMATCH_SUBSTRING)) {
        return `${DDB_ATTR_DEFS_HINT}\n\nAWS message: ${raw}`;
      }
      return raw;
    },
    shortMessage: (raw) => {
      if (raw.toLowerCase().includes(DDB_ATTR_DEFS_MISMATCH_SUBSTRING)) {
        return `${DDB_ATTR_DEFS_HINT} (raw: ${raw})`;
      }
      return raw;
    },
  },
  [ProvisioningErrorKind.UNKNOWN]: {
    errorCode: PROVISIONING_ERROR_CODES.UNKNOWN,
    userPrefix: (raw) => raw,
    shortMessage: (raw) => raw,
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
