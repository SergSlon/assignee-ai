/**
 * `assignee dev update` argument parsing & validation.
 *
 * Separated from `action.ts` for SRP — every input the operator can
 * supply is normalised + validated here, and `action.ts` consumes a
 * single immutable `ResolvedUpdateArgs` record. This mirrors the
 * apply command's `apply/arg-parser.ts` split.
 */

import { AssigneeError } from "@assignee/core";
import { ErrorCode } from "../../constants/errors.js";
import { resolveSourceDir, type ApplyOpts } from "../apply/arg-parser.js";

export interface UpdateOpts {
  source?: string;
  delete?: boolean;
  invalidationPaths?: string;
  /**
   * Commander binds the `--no-invalidation` flag form to
   * `opts.invalidation = false` (the boolean is flipped — the
   * `noInvalidation` key NEVER appears on the parsed opts object).
   * This field is the operator-facing surface; the arg-parser derives
   * the internal `noInvalidation` boolean from it. Default (flag
   * absent) is `true`, which means invalidation runs.
   */
  invalidation?: boolean;
  /**
   * Internal-only / programmatic override. The Commander binding
   * always populates `invalidation` (not `noInvalidation`), but tests
   * + direct callers of `runUpdate` may still pass this for
   * convenience. When BOTH are provided, `invalidation === false`
   * wins (matching the explicit Commander binding).
   */
  noInvalidation?: boolean;
  wait?: boolean;
  yes?: boolean;
  json?: boolean;
  output?: string;
}

export interface ResolvedUpdateArgs {
  target: string;
  resolvedSourceDir: string;
  sourceFileCount: number;
  deleteOrphans: boolean;
  invalidationPaths: string[];
  noInvalidation: boolean;
  wait: boolean;
  yes: boolean;
  jsonMode: boolean;
}

/**
 * RFC 4122 v4 UUID matcher (case-insensitive) — used to detect a
 * `runId` target. apply.ts uses the same format when stamping
 * provision records.
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Classify the `<target>` positional argument into one of three forms.
 *
 *   - `runId`     — provision-record run identifier (UUID).
 *   - `arn`       — full `arn:aws[\w-]*:s3:::<name>` form.
 *   - `bucket`    — bare S3 bucket name.
 *
 * Partition-aware match for ARN form covers `aws`, `aws-us-gov`,
 * `aws-cn` per `feedback_partition_aware_arn_matching`.
 */
export function classifyTarget(raw: string): {
  kind: "runId" | "arn" | "bucket";
  bucketName: string;
} {
  const trimmed = raw.trim();
  if (UUID_REGEX.test(trimmed)) {
    return { kind: "runId", bucketName: "" };
  }
  if (/^arn:aws[\w-]*:s3:::/i.test(trimmed)) {
    const bucket = trimmed.replace(/^arn:aws[\w-]*:s3:::/i, "");
    return { kind: "arn", bucketName: bucket };
  }
  return { kind: "bucket", bucketName: trimmed };
}

/**
 * Validate + normalise every flag/argument the operator passed.
 *
 * Throws `AssigneeError(USAGE_ERROR)` for missing required args, and
 * `AssigneeError(INVALID_SOURCE_DIR)` when --source is missing /
 * empty / nonexistent (delegated to `resolveSourceDir`).
 */
export function resolveUpdateArgs(
  target: string | undefined,
  opts: UpdateOpts,
): ResolvedUpdateArgs {
  if (!target || target.trim() === "") {
    throw new AssigneeError(
      "Usage: assignee dev update <target> --source <dir>\n" +
        "  <target> may be a bucket name, an arn:aws:s3:::… ARN, or a runId UUID.",
      ErrorCode.USAGE_ERROR,
    );
  }
  if (!opts.source || opts.source.trim() === "") {
    throw new AssigneeError(
      "assignee dev update requires --source <dir> — point it at the local site files to upload.",
      ErrorCode.USAGE_ERROR,
    );
  }

  // Reuse the apply command's source-dir validator (existence,
  // non-empty, truncation warning) — exported in apply/arg-parser.ts
  // for this exact reason.
  const sourceShim: ApplyOpts = { source: opts.source };
  const { resolvedSourceDir, sourceFileCount } = resolveSourceDir(sourceShim);
  if (!resolvedSourceDir || sourceFileCount === undefined) {
    // resolveSourceDir guarantees both are set when opts.source is non-
    // empty (and throws otherwise). This is a defensive type-narrowing
    // check — should never fire in practice.
    throw new AssigneeError(
      `Source directory could not be resolved: ${opts.source}`,
      ErrorCode.INVALID_SOURCE_DIR,
    );
  }

  // Comma-split + trim. When `--invalidation-paths` is passed but
  // every entry is empty / whitespace-only after split (e.g. `""`,
  // `","`, `" , , "`), refuse the input rather than silently falling
  // back to `/*` — the operator's intent is unclear and the silent
  // default could invalidate the whole site against their wishes.
  // Apply the AWS 1000-path cap at the service layer (`createInvalidation`),
  // not here, so a single source of truth owns the validation.
  let invalidationPaths: string[] = ["/*"];
  if (opts.invalidationPaths !== undefined) {
    const split = opts.invalidationPaths
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (split.length === 0) {
      throw new AssigneeError(
        "--invalidation-paths cannot be empty; omit the flag for default /* or use --no-invalidation to skip",
        ErrorCode.USAGE_ERROR,
      );
    }
    invalidationPaths = split;
  }

  const jsonMode =
    opts.json === true ||
    (typeof opts.output === "string" && opts.output.toLowerCase() === "json");

  // Derive the internal `noInvalidation` boolean from BOTH possible
  // input shapes:
  //   - Commander's `--no-invalidation` form populates
  //     `opts.invalidation = false`.
  //   - Direct programmatic callers of `runUpdate` may still pass
  //     `noInvalidation: true`.
  // Either form (true) → skip invalidation. Default → run it.
  const noInvalidation =
    opts.invalidation === false || opts.noInvalidation === true;

  return {
    target: target.trim(),
    resolvedSourceDir,
    sourceFileCount,
    deleteOrphans: opts.delete === true,
    invalidationPaths,
    noInvalidation,
    wait: opts.wait === true,
    yes: opts.yes === true,
    jsonMode,
  };
}
