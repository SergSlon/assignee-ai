/**
 * Arg parsing + --source / --set validation for `assignee infra plan`.
 * Wave-6d F4: split out of plan.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as clack from "@clack/prompts";
import { AssigneeError } from "@assignee/core";
import { resolveSetKey } from "../../utils/display.js";
import { countSourceFiles } from "../../utils/count-source-files.js";
import { EXAMPLE_S3_INTENT } from "../../config/constants.js";
import { ErrorCode } from "../../constants/errors.js";

export interface PlanOpts {
  apply?: boolean;
  advice?: boolean;
  source?: string;
  set?: string[];
  output?: string;
  yes?: boolean;
  /** Story 50-2: --quick wizard mode (skip defaulted prompts). */
  quick?: boolean;
  /** Story 108-B-03: include per-resource cost breakdown in plan output. */
  costDetail?: boolean;
}

export interface ResolvedPlanArgs {
  presetFields: Record<string, string>;
  resolvedSourceDir: string | undefined;
  sourceFileCount: number;
  outputFormat: string;
  noApply: boolean;
  /** Story 108-B-03: show per-resource cost breakdown in plan output. */
  costDetail: boolean;
}

export function resolvePlanArgs(
  intent: string | undefined,
  opts: PlanOpts,
): ResolvedPlanArgs {
  const noApply = opts.apply === false;
  const outputFormat = opts.output ?? "text";
  const costDetail = opts.costDetail === true;

  // Parse --set key=value pairs (supports human names via resolveSetKey).
  //
  // Epic 92 u.e (C-17): reject malformed `--set` tokens early with an
  // actionable error instead of silently dropping them. A valid token
  // is `<identifier>=<value>` where `<identifier>` matches
  // /^[A-Za-z_][A-Za-z0-9_.]*$/ and `<value>` is any string (including
  // empty — `--set Tags=` is a legitimate "clear the field" gesture).
  //
  // Before this guard:  `assignee infra plan --set size "Create an EC2"` was
  //   accepted, the `size` token was dropped, and the plan used the
  //   default instance type with no warning.
  // After this guard:   we throw AssigneeError with code USAGE_ERROR
  //   naming the offending token and pointing at the correct syntax.
  const SET_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_.]*=.*$/s;
  const presetFields: Record<string, string> = {};
  for (const kv of opts.set ?? []) {
    if (!SET_TOKEN_RE.test(kv)) {
      // Epic 94 N3 (A-09): stable code `BAD_SET_SYNTAX` + attached
      // `hint` so `plan --json --set BAD-SYNTAX "..."` emits a clean
      // `{ok:false, error:{code:"BAD_SET_SYNTAX", ...}}` envelope via
      // the Wave 94.R5 `--json` error path (plan.ts reads `.hint` off
      // any thrown AssigneeError). Message text preserved so the
      // existing C-17 regex assertion (`/Invalid --set token/`) still
      // matches. Previous code was the generic `USAGE_ERROR`.
      const err = new AssigneeError(
        `Invalid --set token "${kv}". Expected key=value (e.g. --set size=t3.medium).`,
        "BAD_SET_SYNTAX",
      );
      (err as unknown as { hint: string }).hint =
        "Use `--set <key>=<value>` (one pair per flag). Repeat the flag for multiple fields.";
      throw err;
    }
    const eqIdx = kv.indexOf("=");
    const rawKey = kv.slice(0, eqIdx);
    presetFields[resolveSetKey(rawKey)] = kv.slice(eqIdx + 1);
  }

  // Story 37.1: validate --source directory early with clear errors.
  if (opts.source !== undefined && opts.source.trim() === "") {
    throw new AssigneeError(
      "--source requires a non-empty directory path",
      ErrorCode.INVALID_SOURCE_DIR,
    );
  }
  const resolvedSourceDir = opts.source ? path.resolve(opts.source) : undefined;
  let sourceFileCount = 0;
  if (resolvedSourceDir) {
    if (
      !fs.existsSync(resolvedSourceDir) ||
      !fs.statSync(resolvedSourceDir).isDirectory()
    ) {
      throw new AssigneeError(
        `Source directory does not exist: ${resolvedSourceDir}`,
        ErrorCode.INVALID_SOURCE_DIR,
      );
    }
    const { count, truncated } = countSourceFiles(resolvedSourceDir);
    sourceFileCount = count;
    if (truncated) {
      clack.log.warn(
        `Source directory contains > ${sourceFileCount} files or exceeds depth limit — upload may be partial.`,
      );
    }
    if (sourceFileCount === 0) {
      throw new AssigneeError(
        `Source directory is empty: ${resolvedSourceDir}`,
        ErrorCode.INVALID_SOURCE_DIR,
      );
    }
  }

  if (!intent) {
    // Epic 94 N3 (A-03): keep the stable code `MISSING_INTENT` and
    // attach a `hint` so `plan --json ""` can emit a clean
    // `{ok:false, error:{code:"MISSING_INTENT", message, hint}}`
    // envelope. Message text preserved so the existing "Missing
    // intent" substring assertion remains valid.
    const err = new AssigneeError(
      `Missing intent. Usage: assignee infra plan "${EXAMPLE_S3_INTENT}"`,
      "MISSING_INTENT",
    );
    (err as unknown as { hint: string }).hint =
      `Quote your intent, e.g. \`assignee infra plan "${EXAMPLE_S3_INTENT}"\`.`;
    throw err;
  }

  return {
    presetFields,
    resolvedSourceDir,
    sourceFileCount,
    outputFormat,
    noApply,
    costDetail,
  };
}
