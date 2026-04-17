/**
 * Apply CLI argument parsing & validation.
 *
 * Validates --source directory, computes source file counts, and resolves
 * the checkpoint source (explicit --checkpoint flag or auto-detected).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as clack from "@clack/prompts";
import { AssigneeError, CheckpointError, safeTry } from "@assignee/core";
import type { PlanCheckpoint } from "@assignee/core";
import { CHECKPOINT_DIR, EXAMPLE_S3_INTENT } from "../../config/constants.js";
import { ErrorCode } from "../../constants/errors.js";
import {
  findNewestValidCheckpoint,
  loadCheckpointFromPath,
} from "@assignee/core/checkpoint";
import { countSourceFiles } from "../../utils/count-source-files.js";

export interface ApplyOpts {
  wizard?: boolean;
  advice?: boolean;
  yes?: boolean;
  checkpoint?: string;
  source?: string;
  set?: string[];
  /** Story 50-2: --quick wizard mode (skip defaulted prompts). */
  quick?: boolean;
}

export interface ResolvedApplyArgs {
  resolvedCheckpoint: PlanCheckpoint | null;
  resolvedSourceDir: string | undefined;
  sourceFileCount: number | undefined;
  effectiveIntent: string;
}

/**
 * Resolve --checkpoint flag or auto-detect when no intent.
 *
 * When neither intent nor --checkpoint is set, prompts to reuse the newest
 * valid checkpoint. If none is found, throws a usage error.
 */
async function resolveExplicitCheckpoint(
  intent: string | undefined,
  opts: ApplyOpts,
): Promise<PlanCheckpoint | null> {
  if (opts.checkpoint) {
    const cpPath = path.resolve(process.cwd(), opts.checkpoint);
    try {
      return await loadCheckpointFromPath(cpPath);
    } catch (err) {
      if (err instanceof CheckpointError) throw err;
      throw new AssigneeError(
        `Checkpoint file not found: ${cpPath}. Run \`assignee plan\` to create a new plan.`,
        ErrorCode.CHECKPOINT_ERROR,
      );
    }
  }

  if (!intent) {
    const checkpointDir = path.resolve(process.cwd(), CHECKPOINT_DIR);
    const [cpErr, autoCheckpoint] = await safeTry(
      findNewestValidCheckpoint(checkpointDir),
    );

    let resolved: PlanCheckpoint | null = null;
    if (!cpErr && autoCheckpoint && process.stdin.isTTY) {
      const createdDate = new Date(autoCheckpoint.created_at).toLocaleString();
      const confirm = await clack.confirm({
        message: `Reuse plan from ${createdDate} for '${autoCheckpoint.userIntent}'? [Y/n]`,
        initialValue: true,
      });
      if (!clack.isCancel(confirm) && confirm === true) {
        resolved = autoCheckpoint;
      }
    }

    if (!resolved) {
      throw new AssigneeError(
        `Usage: assignee apply "${EXAMPLE_S3_INTENT}"\n` +
          "       assignee apply --checkpoint .assignee/checkpoint-<runId>.json",
        ErrorCode.USAGE_ERROR,
      );
    }
    return resolved;
  }

  return null;
}

/**
 * Validate --source dir exists, non-empty, counts files; warn on truncation.
 */
function resolveSourceDir(opts: ApplyOpts): {
  resolvedSourceDir: string | undefined;
  sourceFileCount: number | undefined;
} {
  if (opts.source !== undefined && opts.source.trim() === "") {
    throw new AssigneeError(
      "--source requires a non-empty directory path",
      ErrorCode.INVALID_SOURCE_DIR,
    );
  }
  const resolvedSourceDir = opts.source ? path.resolve(opts.source) : undefined;
  let sourceFileCount: number | undefined;
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
      process.stderr.write(
        `⚠  Source directory contains > ${sourceFileCount} files or exceeds depth limit — upload may be partial.\n`,
      );
    }
    if (sourceFileCount === 0) {
      throw new AssigneeError(
        `Source directory is empty: ${resolvedSourceDir}`,
        ErrorCode.INVALID_SOURCE_DIR,
      );
    }
  }
  return { resolvedSourceDir, sourceFileCount };
}

/**
 * Resolve all apply args (checkpoint, source, effective intent).
 */
export async function resolveApplyArgs(
  intent: string | undefined,
  opts: ApplyOpts,
): Promise<ResolvedApplyArgs> {
  const resolvedCheckpoint = await resolveExplicitCheckpoint(intent, opts);
  const { resolvedSourceDir, sourceFileCount } = resolveSourceDir(opts);
  const effectiveIntent = intent ?? resolvedCheckpoint?.userIntent ?? "";
  return {
    resolvedCheckpoint,
    resolvedSourceDir,
    sourceFileCount,
    effectiveIntent,
  };
}

/**
 * Parse the repeatable --set key=value entries into a preset-fields map.
 *
 * Key resolution is delegated to the caller (passed in) so this module
 * stays independent of utils/display.ts.
 */
export function parsePresetFields(
  setFlag: string[] | undefined,
  resolveKey: (raw: string) => string,
): Record<string, string> | undefined {
  if (!setFlag?.length) return undefined;
  return Object.fromEntries(
    setFlag.map((kv) => {
      const eq = kv.indexOf("=");
      return eq > 0
        ? [resolveKey(kv.slice(0, eq)), kv.slice(eq + 1)]
        : [resolveKey(kv), "true"];
    }),
  );
}
