/**
 * `assignee update` action — orchestrates resolve → confirm → upload →
 * invalidate → render.
 *
 * The action is split from the Commander wrapper (`update.ts`) so tests
 * can drive it directly without going through `parseAsync`. Mirrors the
 * apply / destroy split.
 */

import { randomUUID } from "node:crypto";
import * as clack from "@clack/prompts";
import chalk from "chalk";
import {
  AssigneeError,
  serializeErrorEnvelope,
  type JsonErrorDetail,
  uploadStaticSite,
  createInvalidation,
  waitForInvalidation,
} from "@assignee/core";
import { appendAuditRecord } from "@assignee/core/audit";
import { ErrorCode, ProcessExitCode } from "../../constants/errors.js";
import { resolveUpdateArgs } from "./arg-parser.js";
import type { UpdateOpts } from "./arg-parser.js";
import {
  resolveUpdateTarget,
  type UpdateTarget,
  type ResolveOptions,
} from "./resolve-target.js";
export type { UpdateOpts };

/**
 * Shape returned by the action when invoked programmatically. Mirrors
 * the JSON envelope but in unflattened form so the Commander wrapper
 * can format either text or JSON output from the same data.
 */
export interface UpdateActionResult {
  runId: string;
  target: UpdateTarget;
  upload: {
    uploaded: number;
    failed: number;
    deleted: number;
    totalBytes: number;
    errors: Array<{ file: string; error: string }>;
  };
  invalidation?: {
    invalidationId: string;
    status: string;
  };
}

interface RunOptions {
  /**
   * Test seam — drives the confirmation prompt without a real TTY.
   * `undefined` defers to the real `@clack/prompts.confirm`.
   */
  confirm?: (message: string) => Promise<boolean>;
  /**
   * Test seam — overrides the resolver's data sources without
   * touching the global memory service / SDK.
   */
  resolveOptions?: ResolveOptions;
  /**
   * Test seam — overrides the --wait poll timeout (ms) passed to
   * `waitForInvalidation`. Defaults to the service's built-in 10-min
   * timeout. Inject a small value (e.g. 50) in tests to avoid long waits.
   */
  waitTimeoutMs?: number;
}

/**
 * Format a byte count for human display. Mirrors
 * `static-site-upload.ts::formatBytes` so the two upload paths render
 * the same human-readable totals.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Drive the full `assignee update` flow. The Commander wrapper handles
 * argv parsing + JSON envelope serialisation; this function owns the
 * actual work + the text-mode rendering.
 */
export async function runUpdate(
  target: string | undefined,
  rawOpts: UpdateOpts,
  options: RunOptions = {},
): Promise<UpdateActionResult> {
  const args = resolveUpdateArgs(target, rawOpts);
  const runId = randomUUID();

  // ── 0. Conflicting-flag warning ──────────────────────────────────
  // `--wait` only has something to wait for when invalidation runs.
  // When both `--wait` and `--no-invalidation` are passed, the wait
  // is silently ineffective — surface a one-line warn so the operator
  // notices. Suppressed in JSON mode (the envelope has no `warnings`
  // field today; surfacing it via stderr would still pollute the
  // tool-consumer's stream, so we just drop it).
  if (args.wait && args.noInvalidation && !args.jsonMode) {
    process.stderr.write(
      "Warning: --wait is ignored when --no-invalidation is set (nothing to wait for).\n",
    );
  }

  // ── 1. Resolve target (bucket + region + optional distribution) ────
  const resolved = await resolveUpdateTarget(args.target, {
    skipCloudFrontLookup: args.noInvalidation,
    ...(options.resolveOptions ?? {}),
  });

  // Surface what we'll act on, in text mode only.
  if (!args.jsonMode) {
    process.stderr.write(
      `[update] target bucket: ${chalk.bold(resolved.bucketName)} (${resolved.region})\n`,
    );
    if (args.noInvalidation) {
      process.stderr.write(
        "[update] --no-invalidation set — skipping CloudFront refresh\n",
      );
    } else if (resolved.distributionId) {
      process.stderr.write(
        `[update] linked distribution: ${chalk.bold(resolved.distributionId)}` +
          (resolved.cloudFrontDomainName
            ? ` (${resolved.cloudFrontDomainName})\n`
            : "\n"),
      );
    } else {
      process.stderr.write(
        chalk.yellow(
          `[update] no linked CloudFront distribution for ${resolved.bucketName} — proceeding with upload only.\n`,
        ),
      );
    }
  }

  // ── 2. Required-distribution guard (when --no-invalidation NOT set) ─
  // When invalidation IS requested but we found no distribution, refuse
  // to proceed silently — the operator's intent is unclear. Mirrors the
  // command-design spec: zero matches → throw USAGE_ERROR.
  if (!args.noInvalidation && !resolved.distributionId) {
    throw new AssigneeError(
      `No CloudFront distribution linked to s3://${resolved.bucketName} — pass --no-invalidation if intentional, otherwise run \`assignee plan\` to create a static-website compound.`,
      ErrorCode.USAGE_ERROR,
    );
  }

  // ── 3. Confirmation gate ─────────────────────────────────────────
  // B7 (Q-H-003): when in a non-TTY context without --yes or --json,
  // the prompt would be silently skipped — the command would proceed
  // without any confirmation, which is surprising for operators piping
  // output. Mirror bulk-action.ts:603-607: throw USAGE_ERROR so the
  // operator knows they need to add --yes or --json.
  if (!args.yes && !args.jsonMode && !process.stdin.isTTY) {
    throw new AssigneeError(
      "Cannot update interactively in a non-TTY context — pass --yes to confirm or --json to use JSON envelope.",
      ErrorCode.USAGE_ERROR,
    );
  }
  if (!args.yes && !args.jsonMode && process.stdin.isTTY) {
    const summary =
      `Update s3://${resolved.bucketName} from ${args.resolvedSourceDir} (${args.sourceFileCount} file${args.sourceFileCount === 1 ? "" : "s"})` +
      (args.deleteOrphans ? " + delete remote orphans" : "") +
      (resolved.distributionId
        ? ` + invalidate CloudFront ${resolved.distributionId} paths=${args.invalidationPaths.join(",")}`
        : "");
    const confirmFn =
      options.confirm ??
      (async (msg: string) => {
        const answer = await clack.confirm({
          message: msg,
          initialValue: true,
        });
        return !clack.isCancel(answer) && answer === true;
      });
    const ok = await confirmFn(summary);
    if (!ok) {
      throw new AssigneeError("User cancelled", ErrorCode.USER_CANCELLED);
    }
  }

  // ── 4. Cost-guard log (pricing URL, no hardcoded $) ─────────────
  // A9 (M-H-016): hardcoded price literals violate feedback_no_hardcoded_prices.
  // Direct operators to the live AWS pricing page instead.
  if (!args.jsonMode && !args.noInvalidation && resolved.distributionId) {
    process.stderr.write(
      `[update] invalidating ${args.invalidationPaths.length} path(s) — CloudFront invalidation has a per-path AWS fee after the monthly free tier; see https://aws.amazon.com/cloudfront/pricing/ for current rates.\n`,
    );
  }

  // ── 5. Upload ─────────────────────────────────────────────────────
  const spinner = !args.jsonMode ? clack.spinner() : undefined;
  spinner?.start("Uploading files...");
  const uploadResult = await uploadStaticSite(
    resolved.bucketName,
    args.resolvedSourceDir,
    {
      region: resolved.region,
      deleteOrphans: args.deleteOrphans,
      onProgress: (p) => {
        spinner?.message(`Uploading ${p.current}/${p.total}: ${p.file}`);
      },
    },
  );
  // B9 (S-H-014/015/016): use singular/plural grammar correctly.
  spinner?.stop(
    `Uploaded ${uploadResult.uploaded} ${uploadResult.uploaded === 1 ? "file" : "files"} (${formatBytes(uploadResult.totalBytes)})` +
      (args.deleteOrphans
        ? `, deleted ${uploadResult.deleted} ${uploadResult.deleted === 1 ? "orphan" : "orphans"}`
        : ""),
  );
  if (uploadResult.failed > 0) {
    // A4 (M-H-010): set non-zero exit code when any files fail to upload.
    // Previously the command exited 0 even on partial failures, making
    // CI pipelines silently succeed while files were missing from the
    // deployed bucket.
    process.exitCode = ProcessExitCode.GENERIC_ERROR;
    if (!args.jsonMode) {
      process.stderr.write(
        chalk.yellow(
          `⚠ ${uploadResult.failed} ${uploadResult.failed === 1 ? "file" : "files"} failed to upload\n`,
        ),
      );
      for (const e of uploadResult.errors) {
        process.stderr.write(chalk.dim(`  ${e.file}: ${e.error}\n`));
      }
    }
  }

  // ── 6. Invalidation ──────────────────────────────────────────────
  let invalidation: UpdateActionResult["invalidation"];
  if (!args.noInvalidation && resolved.distributionId) {
    const created = await createInvalidation({
      distributionId: resolved.distributionId,
      paths: args.invalidationPaths,
      callerReference: runId,
      region: resolved.region,
    });
    invalidation = {
      invalidationId: created.invalidationId,
      status: created.status,
    };
    if (!args.jsonMode) {
      process.stderr.write(
        `[update] invalidation ${chalk.bold(created.invalidationId)} ` +
          `created (status=${created.status})\n`,
      );
    }
    if (args.wait) {
      const polled = await waitForInvalidation(
        resolved.distributionId,
        created.invalidationId,
        {
          region: resolved.region,
          ...(options.waitTimeoutMs !== undefined
            ? { timeoutMs: options.waitTimeoutMs }
            : {}),
        },
      );
      invalidation.status = polled.status;
      if (polled.timedOut === true) {
        // A5 (M-H-011): surface a distinct non-zero exit code and
        // stderr line when the wait times out rather than treating it
        // the same as a successful complete.
        process.exitCode = ProcessExitCode.GENERIC_ERROR;
        if (!args.jsonMode) {
          process.stderr.write(
            `[update] invalidation ${created.invalidationId} did not complete within the wait timeout — status: ${polled.status}\n`,
          );
        }
      } else if (!args.jsonMode) {
        process.stderr.write(
          `[update] invalidation final status: ${polled.status}` +
            (polled.completedAt
              ? ` (completed at ${polled.completedAt.toISOString()})`
              : "") +
            "\n",
        );
      }
    }
  }

  // ── 7. Render success summary (text mode only) ────────────────────
  if (!args.jsonMode) {
    const url = resolved.cloudFrontDomainName
      ? `https://${resolved.cloudFrontDomainName}`
      : undefined;
    process.stdout.write(chalk.green("\n✓ update complete\n"));
    process.stdout.write(
      `  bucket: s3://${resolved.bucketName} (${resolved.region})\n`,
    );
    process.stdout.write(
      `  uploaded: ${uploadResult.uploaded}, ` +
        `deleted: ${uploadResult.deleted}, ` +
        `failed: ${uploadResult.failed}, ` +
        `total: ${formatBytes(uploadResult.totalBytes)}\n`,
    );
    if (invalidation) {
      process.stdout.write(
        `  invalidation: ${invalidation.invalidationId} (${invalidation.status})\n`,
      );
    }
    if (url) {
      process.stdout.write(`  site: ${chalk.cyan(url)}\n`);
    }
  }

  // ── 8. Audit log (best-effort; only on full success) ─────────────────
  // Skip the audit record when any files failed to upload — partial
  // failure state is ambiguous and the caller already set a non-zero
  // exit code. Audit intent: record successful updates for compliance
  // and operator review.
  if (uploadResult.failed === 0) {
    try {
      await appendAuditRecord({
        action: "update_executed",
        bucketName: resolved.bucketName,
        region: resolved.region,
        uploaded: uploadResult.uploaded,
        deleted: uploadResult.deleted,
        failed: uploadResult.failed,
        runId,
        ...(invalidation
          ? { invalidationId: invalidation.invalidationId }
          : {}),
      });
    } catch (err) {
      // Audit write failure must NOT abort the command — mirror the
      // bulk-destroy pattern (bulk-action.ts:857-866).
      process.stderr.write(
        `[update] WARNING: Failed to write audit log entry: ` +
          `${err instanceof Error ? err.message : String(err)}\n` +
          `  Check ~/.assignee/audit/ permissions.\n`,
      );
    }
  }

  return {
    runId,
    target: resolved,
    upload: {
      uploaded: uploadResult.uploaded,
      failed: uploadResult.failed,
      deleted: uploadResult.deleted,
      totalBytes: uploadResult.totalBytes,
      errors: uploadResult.errors,
    },
    ...(invalidation ? { invalidation } : {}),
  };
}

/**
 * Top-level command entrypoint — owns the JSON envelope + exit-code
 * mapping. The Commander wrapper calls into this; the action above is
 * test-callable on its own.
 *
 * The optional `options` parameter mirrors `runUpdate`'s test-seam
 * interface so tests can inject `resolveOptions` without going through
 * Commander `parseAsync`.
 */
export async function updateAction(
  target: string | undefined,
  rawOpts: UpdateOpts,
  options: RunOptions = {},
): Promise<void> {
  const jsonMode =
    rawOpts.json === true ||
    (typeof rawOpts.output === "string" &&
      rawOpts.output.toLowerCase() === "json");

  try {
    const result = await runUpdate(target, rawOpts, options);
    if (jsonMode) {
      // B2 (S-H-001 / S-H-002): align JSON envelope shape with the
      // `apply` command (apps/cli/src/commands/apply.ts:267):
      //   { ok: boolean, operation: string, runId, ...result }
      // Replaces the previous `command`/`status` shape which was
      // incompatible with downstream consumers expecting `ok`/`operation`.
      const envelope = {
        ok: result.upload.failed === 0,
        operation: "update",
        runId: result.runId,
        result: {
          bucketName: result.target.bucketName,
          region: result.target.region,
          ...(result.target.distributionId
            ? { distributionId: result.target.distributionId }
            : {}),
          uploaded: result.upload.uploaded,
          deleted: result.upload.deleted,
          failed: result.upload.failed,
          totalBytes: result.upload.totalBytes,
          ...(result.invalidation
            ? {
                invalidationId: result.invalidation.invalidationId,
                invalidationStatus: result.invalidation.status,
              }
            : {}),
          ...(result.target.cloudFrontDomainName
            ? { url: `https://${result.target.cloudFrontDomainName}` }
            : {}),
        },
        errors: result.upload.errors,
      };
      process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
    }
  } catch (err) {
    if (jsonMode) {
      const code = err instanceof AssigneeError ? err.code : "UNKNOWN_ERROR";
      const message = err instanceof Error ? err.message : String(err);
      const hint =
        err instanceof AssigneeError && err.code === ErrorCode.USAGE_ERROR
          ? "Run `assignee update --help` for the supported flags."
          : "Run with --verbose for full stack trace.";
      const detail: JsonErrorDetail | undefined = undefined;
      process.stdout.write(serializeErrorEnvelope(code, message, hint, detail));
    } else if (err instanceof AssigneeError) {
      process.stderr.write(`Error: ${err.message}\n`);
    } else {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    if (err instanceof AssigneeError && err.code === ErrorCode.USAGE_ERROR) {
      process.exitCode = ProcessExitCode.USAGE_ERROR;
    } else if (
      err instanceof AssigneeError &&
      err.code === ErrorCode.USER_CANCELLED
    ) {
      process.exitCode = ProcessExitCode.GENERIC_ERROR;
    } else {
      process.exitCode = ProcessExitCode.GENERIC_ERROR;
    }
  }
}
