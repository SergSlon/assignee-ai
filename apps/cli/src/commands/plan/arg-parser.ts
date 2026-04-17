/**
 * Arg parsing + --source / --set validation for `assignee plan`.
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
}

export interface ResolvedPlanArgs {
  presetFields: Record<string, string>;
  resolvedSourceDir: string | undefined;
  sourceFileCount: number;
  outputFormat: string;
  noApply: boolean;
}

export function resolvePlanArgs(
  intent: string | undefined,
  opts: PlanOpts,
): ResolvedPlanArgs {
  const noApply = opts.apply === false;
  const outputFormat = opts.output ?? "text";

  // Parse --set key=value pairs (supports human names via resolveSetKey).
  const presetFields: Record<string, string> = {};
  for (const kv of opts.set ?? []) {
    const eqIdx = kv.indexOf("=");
    if (eqIdx > 0) {
      const rawKey = kv.slice(0, eqIdx);
      presetFields[resolveSetKey(rawKey)] = kv.slice(eqIdx + 1);
    }
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
    throw new AssigneeError(
      `Missing intent. Usage: assignee plan "${EXAMPLE_S3_INTENT}"`,
      "MISSING_INTENT",
    );
  }

  return {
    presetFields,
    resolvedSourceDir,
    sourceFileCount,
    outputFormat,
    noApply,
  };
}
