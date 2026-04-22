/**
 * validate-desired-state — plan-time validation for desiredState values.
 *
 * Epic 92 e92.u.c.1 (A-13): fail fast on invalid BucketName / queue-name /
 * etc. BEFORE CloudControl rejects them. Provides:
 *   - Pure, per-resource-type validators (e.g. `validateS3BucketName`).
 *   - `validateDesiredState(resourceType, desiredState)` dispatcher.
 *   - `validateDesiredStateNode(state)` graph-node wrapper that sets
 *     `ExecutionStatus.FAILED` with a `[ERROR] ... [FIX] ...` message on
 *     failure and passes through on success.
 *
 * Scope in this module: AWS::S3::Bucket only. The dispatcher is
 * extensible — additional resource types slot in via the
 * `DESIRED_STATE_VALIDATORS` registry below.
 *
 * Out of scope (follow-up): wiring `validateDesiredStateNode` into
 * `create-graph.ts` between PLAN_GENERATOR and ADVICE_GENERATOR (or as
 * part of PREFLIGHT_GUARD's guard chain). See
 * `_bmad-output/implementation-artifacts/e92-uc1-sqs-s3validate.md` §F3.
 */

import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { AssigneeError } from "../../errors.js";
import { ExecutionStatus } from "../../schema/graph-state.js";
import type { AgentState } from "../graph-state.js";

/**
 * Machine-readable error code emitted when the `validateDesiredStateNode`
 * fails. Surfaces through the CLI's `--output json` envelope as
 * `error.code === "INVALID_DESIRED_STATE"` so CI/automation can detect
 * plan-time validation failures without string-matching the human message.
 */
export const INVALID_DESIRED_STATE_CODE = "INVALID_DESIRED_STATE";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a single field/value validation check. */
export interface ValidationResult {
  ok: boolean;
  /** Human-readable error message when ok === false. */
  error?: string;
  /** Actionable fix hint — surfaced as "[FIX] <hint>" in node output. */
  fix?: string;
}

/** Aggregate result produced by the dispatcher. */
export interface AggregateValidationResult {
  ok: boolean;
  errors: ValidationResult[];
}

// ---------------------------------------------------------------------------
// S3 BucketName validator
// ---------------------------------------------------------------------------

/**
 * Regex anchors for bucket-name rules. Extracted so individual rules can
 * be exercised in tests without re-scanning a catch-all string.
 */
const S3_BUCKET_NAME_RULES = {
  CHARSET: /^[a-z0-9.-]+$/,
  START_END: /^[a-z0-9].*[a-z0-9]$/,
  ADJACENT_DOT: /\.\./,
  DOT_HYPHEN: /\.-|-\./,
  IPV4: /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  PREFIX_XN: /^xn--/,
  PREFIX_STHREE: /^sthree-/,
  SUFFIX_S3ALIAS: /-s3alias$/,
} as const;

/**
 * Validate an S3 bucket name against AWS's published naming rules.
 *
 * Rules enforced (per
 * https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html):
 *   1. Length 3-63 characters.
 *   2. Charset: lowercase letters, digits, hyphens, periods.
 *   3. Must start AND end with a letter or digit.
 *   4. No adjacent dots ("..").
 *   5. No ".-" or "-." adjacency.
 *   6. Must NOT be IPv4-shaped.
 *   7. Must NOT start with "xn--" (IDN ACE prefix, reserved).
 *   8. Must NOT start with "sthree-" or "sthree-configurator" (reserved).
 *   9. Must NOT end with "-s3alias" (reserved for access-point aliases).
 *
 * Empty / undefined names are treated as "valid" (AWS auto-generates a
 * name when BucketName is omitted from the CloudFormation template).
 */
export function validateS3BucketName(name: string): ValidationResult {
  if (!name) {
    return { ok: true };
  }

  if (name.length < 3 || name.length > 63) {
    return {
      ok: false,
      error: `S3 BucketName "${name}" length ${name.length} is outside the 3-63 character range.`,
      fix: "Use a name between 3 and 63 characters. Leave BucketName blank to let AWS auto-generate one.",
    };
  }

  if (!S3_BUCKET_NAME_RULES.CHARSET.test(name)) {
    return {
      ok: false,
      error: `S3 BucketName "${name}" contains characters outside [a-z0-9.-].`,
      fix: "Use only lowercase letters, digits, hyphens, and periods. Uppercase, underscores, and spaces are not allowed.",
    };
  }

  if (!S3_BUCKET_NAME_RULES.START_END.test(name)) {
    return {
      ok: false,
      error: `S3 BucketName "${name}" must start and end with a lowercase letter or digit.`,
      fix: "Remove any leading/trailing '.' or '-'. Example: 'app-logs-prod' instead of '.app-logs-prod'.",
    };
  }

  if (S3_BUCKET_NAME_RULES.ADJACENT_DOT.test(name)) {
    return {
      ok: false,
      error: `S3 BucketName "${name}" contains adjacent dots (".."), which AWS forbids.`,
      fix: "Replace the '..' with a single '.' or a '-'. Example: 'app.logs.prod' instead of 'app..logs.prod'.",
    };
  }

  if (S3_BUCKET_NAME_RULES.DOT_HYPHEN.test(name)) {
    return {
      ok: false,
      error: `S3 BucketName "${name}" contains a '.-' or '-.' adjacency, which AWS forbids.`,
      fix: "Drop the '.' next to the '-'. Example: 'app-logs-prod' or 'app.logs.prod'.",
    };
  }

  if (S3_BUCKET_NAME_RULES.IPV4.test(name)) {
    return {
      ok: false,
      error: `S3 BucketName "${name}" is IPv4-shaped, which AWS forbids (prevents DNS spoofing of bucket URLs).`,
      fix: "Use a DNS-safe identifier instead of an IP literal. Example: 'assignee-logs-prod'.",
    };
  }

  if (S3_BUCKET_NAME_RULES.PREFIX_XN.test(name)) {
    return {
      ok: false,
      error: `S3 BucketName "${name}" starts with "xn--" (IDN ACE prefix), which AWS reserves.`,
      fix: "Choose a name that does not begin with 'xn--'. Example: 'my-bucket' instead of 'xn--my-bucket'.",
    };
  }

  if (S3_BUCKET_NAME_RULES.PREFIX_STHREE.test(name)) {
    return {
      ok: false,
      error: `S3 BucketName "${name}" starts with "sthree-" (reserved by AWS for internal use).`,
      fix: "Choose a different prefix. 'sthree-' and 'sthree-configurator-' are reserved.",
    };
  }

  if (S3_BUCKET_NAME_RULES.SUFFIX_S3ALIAS.test(name)) {
    return {
      ok: false,
      error: `S3 BucketName "${name}" ends with "-s3alias" (reserved for S3 access-point aliases).`,
      fix: "Choose a different suffix. '-s3alias' is reserved; access-point aliases are auto-generated by AWS.",
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

type DesiredStateValidator = (
  desiredState: Record<string, unknown>,
) => ValidationResult[];

/**
 * Registry of per-resource-type validators. Extensible — add new entries
 * here as each plan-time validation lands (e.g. SQS, DynamoDB,
 * CloudFront, IAM role names).
 */
const DESIRED_STATE_VALIDATORS: Record<string, DesiredStateValidator> = {
  [RESOURCE_TYPES.S3_BUCKET]: (desiredState) => {
    const results: ValidationResult[] = [];
    const bucketName = desiredState["BucketName"];
    if (typeof bucketName === "string" && bucketName.length > 0) {
      results.push(validateS3BucketName(bucketName));
    }
    return results;
  },
};

/**
 * Validate a desiredState payload for a given resource type. Returns the
 * aggregate outcome: `ok` is `true` only when every individual check
 * returned `ok: true`.
 */
export function validateDesiredState(
  resourceType: string,
  desiredState: Record<string, unknown> | undefined,
): AggregateValidationResult {
  if (!desiredState) return { ok: true, errors: [] };
  const validator = DESIRED_STATE_VALIDATORS[resourceType];
  if (!validator) return { ok: true, errors: [] };

  const results = validator(desiredState);
  const errors = results.filter((r) => !r.ok);
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Graph node wrapper
// ---------------------------------------------------------------------------

/**
 * Format a ValidationResult as a user-visible string with the stable
 * `[ERROR] ... [FIX] ...` prefix already used elsewhere in the guard chain.
 */
export function formatValidationError(r: ValidationResult): string {
  const errorPart = `[ERROR] ${r.error ?? "desiredState validation failed"}`;
  const fixPart = r.fix ? ` [FIX] ${r.fix}` : "";
  return `${errorPart}${fixPart}`;
}

/**
 * LangGraph-compatible node. On validation failure, sets
 * `executionStatus = FAILED` with a structured `[ERROR] ... [FIX] ...`
 * message. On success, returns an empty state patch so the graph falls
 * through to the next node unchanged.
 *
 * Only runs when `state.executionStatus === PENDING` — matches the
 * short-circuit convention used by preflight-guard.
 */
export async function validateDesiredStateNode(
  state: AgentState,
): Promise<Partial<AgentState>> {
  if (state.executionStatus !== ExecutionStatus.PENDING) return {};
  if (!state.resourceType) return {};

  const { ok, errors } = validateDesiredState(
    state.resourceType,
    state.desiredState as Record<string, unknown> | undefined,
  );

  if (ok) return {};

  const firstError = errors[0];
  if (!firstError) return {};

  const errorMessage = formatValidationError(firstError);

  return {
    executionStatus: ExecutionStatus.FAILED,
    errorMessage,
    // Epic 94 R1: carry a machine-readable code so the CLI JSON envelope
    // path surfaces `error.code: "INVALID_DESIRED_STATE"`. Downstream
    // `formatErrorResult` already reads `state.error` through
    // `defaultErrorMessageRegistry.resolve(...)`.
    error: new AssigneeError(errorMessage, INVALID_DESIRED_STATE_CODE),
  };
}
