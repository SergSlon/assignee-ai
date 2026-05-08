/**
 * W4-04 (Epic 100 Round 3) — `assignee restore-provisions` command.
 *
 * Restores `~/.assignee/memory/provisions.json` from a dated backup
 * created by `scripts/backup-provisions.ts`. Idempotent — restoring the
 * same backup twice is safe (overwrites the target with identical content).
 *
 * Usage:
 *   assignee restore-provisions [--from <YYYY-MM-DD>]
 *
 * Options:
 *   --from <date>   Restore from a specific date (YYYY-MM-DD). When omitted
 *                   the command restores from the most recent available
 *                   backup.
 *
 * Sensitive-marker note:
 *   provisions.json on disk is already post-scrub (W1-01: memory-recorder.ts
 *   applies `stripSensitiveFromElicited` + `redactAccountIdsInPrompt` before
 *   writing). Backups inherit the same guarantees. This command copies the
 *   backup back — no fresh scrubbing is needed or performed.
 *
 * Security:
 *   - Restored file is written with 0o600 (atomic temp-rename + chmod).
 *   - A safety copy of the current file is written to
 *     `<memory-dir>/provisions.json.pre-restore.<timestamp>` before
 *     overwriting, so the operator can recover from a mistaken restore.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { Command } from "commander";
import { ErrorCode, ProcessExitCode } from "../constants/errors.js";
import { AssigneeError, ProvisionLogSchema } from "@assignee/core";
import { restoreFromAuditLog } from "./restore-provisions-audit-log.js";

// ── Constants ─────────────────────────────────────────────────────────

const DEFAULT_MEMORY_DIR = path.join(os.homedir(), ".assignee", "memory");
const DEFAULT_BACKUP_DIR = path.join(os.homedir(), ".assignee", "backups");
const PROVISIONS_FILE = "provisions.json";
const BACKUP_PREFIX = "provisions-";

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Write a file atomically: temp file + rename + 0o600 chmod.
 * Same pattern as `scripts/backup-provisions.ts` and `file-store.ts`.
 */
async function atomicWrite(destPath: string, content: Buffer): Promise<void> {
  const tmpSuffix = randomBytes(8).toString("hex");
  const tmpPath = `${destPath}.tmp.${tmpSuffix}`;
  await fs.writeFile(tmpPath, content, { mode: 0o600 });
  await fs.rename(tmpPath, destPath);
  try {
    await fs.chmod(destPath, 0o600);
  } catch {
    // Best-effort on non-POSIX (e.g. some Windows configurations).
  }
}

/** Parse YYYY-MM-DD from a backup filename. Returns null on mismatch. */
function parseDateFromFilename(name: string): Date | null {
  if (!name.startsWith(BACKUP_PREFIX) || !name.endsWith(".json")) return null;
  const datePart = name.slice(BACKUP_PREFIX.length, -".json".length);
  const d = new Date(`${datePart}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Find the most recent backup file in `backupDir`.
 * Returns the absolute file path, or null when no backups exist.
 */
async function findLatestBackup(backupDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fs.readdir(backupDir);
  } catch {
    return null;
  }

  const backups: Array<{ date: Date; name: string }> = [];
  for (const name of entries) {
    const d = parseDateFromFilename(name);
    if (d) backups.push({ date: d, name });
  }

  if (backups.length === 0) return null;

  backups.sort((a, b) => b.date.getTime() - a.date.getTime());
  return path.join(backupDir, backups[0]!.name);
}

// ── Core restore logic (exported for testing) ─────────────────────────

export interface RestoreOptions {
  from?: string;
  memoryDir?: string;
  backupDir?: string;
}

export interface RestoreResult {
  restored: boolean;
  sourcePath: string | null;
  targetPath: string;
  safetyBackupPath: string | null;
  message: string;
}

/**
 * Core restore logic. Exported for unit testing.
 *
 * @param options.from       - Optional YYYY-MM-DD date string.
 * @param options.memoryDir  - Override memory directory (default: ~/.assignee/memory).
 * @param options.backupDir  - Override backup directory (default: ~/.assignee/backups).
 */
export async function restoreProvisions(
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const memoryDir = options.memoryDir ?? DEFAULT_MEMORY_DIR;
  const backupDir = options.backupDir ?? DEFAULT_BACKUP_DIR;
  const targetPath = path.join(memoryDir, PROVISIONS_FILE);

  // Resolve the source backup file.
  let sourcePath: string | null = null;
  if (options.from) {
    // Validate date format and calendar existence (e.g. reject "2026-02-31").
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.from)) {
      return {
        restored: false,
        sourcePath: null,
        targetPath,
        safetyBackupPath: null,
        message: `Invalid date format: "${options.from}". Expected YYYY-MM-DD.`,
      };
    }
    const parsedDate = new Date(`${options.from}T00:00:00Z`);
    if (
      isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== options.from
    ) {
      return {
        restored: false,
        sourcePath: null,
        targetPath,
        safetyBackupPath: null,
        message: `Invalid date: "${options.from}" does not exist. Check day/month combination.`,
      };
    }
    const candidate = path.join(
      backupDir,
      `${BACKUP_PREFIX}${options.from}.json`,
    );
    try {
      await fs.access(candidate);
      sourcePath = candidate;
    } catch {
      return {
        restored: false,
        sourcePath: null,
        targetPath,
        safetyBackupPath: null,
        message: `No backup found for date ${options.from} at: ${candidate}`,
      };
    }
  } else {
    sourcePath = await findLatestBackup(backupDir);
    if (!sourcePath) {
      return {
        restored: false,
        sourcePath: null,
        targetPath,
        safetyBackupPath: null,
        message: `No backup files found in: ${backupDir}`,
      };
    }
  }

  // Read the backup.
  let content: Buffer;
  try {
    content = await fs.readFile(sourcePath);
  } catch (err) {
    return {
      restored: false,
      sourcePath,
      targetPath,
      safetyBackupPath: null,
      message: `Failed to read backup file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Validate the backup against the live-store schema before overwriting.
  // A corrupted or schema-mismatched backup must never reach the live ledger
  // because the backup is the disaster-recovery artifact — corruption there
  // is the single point of failure (PR-020).
  try {
    const parsed: unknown = JSON.parse(content.toString("utf8"));
    const validation = ProvisionLogSchema.safeParse(parsed);
    if (!validation.success) {
      const firstError = validation.error.errors[0];
      const errorDetail = firstError
        ? `${firstError.path.join(".") || "<root>"}: ${firstError.message}`
        : validation.error.message;
      return {
        restored: false,
        sourcePath,
        targetPath,
        safetyBackupPath: null,
        message:
          `Backup file failed schema validation — refusing to overwrite live ledger. ` +
          `Examine the backup manually or provide a different date. ` +
          `Validation error: ${errorDetail}`,
      };
    }
  } catch {
    return {
      restored: false,
      sourcePath,
      targetPath,
      safetyBackupPath: null,
      message:
        `Backup file is not valid JSON — refusing to overwrite live ledger. ` +
        `Examine the backup manually or provide a different date.`,
    };
  }

  // Ensure memory directory exists.
  await fs.mkdir(memoryDir, { recursive: true, mode: 0o700 });

  // Safety copy: preserve the current provisions.json before overwriting.
  let safetyBackupPath: string | null = null;
  const currentExists = fsSync.existsSync(targetPath);
  if (currentExists) {
    safetyBackupPath = `${targetPath}.pre-restore.${Date.now()}`;
    try {
      await fs.copyFile(targetPath, safetyBackupPath);
      try {
        await fs.chmod(safetyBackupPath, 0o600);
      } catch {
        // Best-effort.
      }
    } catch {
      safetyBackupPath = null;
    }
  }

  // Atomic write to target.
  await atomicWrite(targetPath, content);

  const backupDateMatch = /provisions-(\d{4}-\d{2}-\d{2})\.json$/.exec(
    path.basename(sourcePath),
  );
  const dateLabel = backupDateMatch ? backupDateMatch[1] : "unknown";

  return {
    restored: true,
    sourcePath,
    targetPath,
    safetyBackupPath,
    message: `Restored provisions.json from backup dated ${dateLabel}.${
      safetyBackupPath
        ? ` Previous file saved to: ${path.basename(safetyBackupPath)}`
        : ""
    }`,
  };
}

// ── Commander command ─────────────────────────────────────────────────

/**
 * Build a fresh `restore-provisions` Commander subcommand instance.
 *
 * Tests dispatching `parseAsync` against the same Commander instance
 * inherit its mutated option state — re-running with `--from-audit-log`
 * after a previous `--from` invocation can leave `from` populated from
 * the prior parse, leaking across tests (L3 of Wave B-2 review). Tests
 * call this factory for a fresh instance per test; production exports
 * the singleton built once at module load.
 */
export function createRestoreProvisionsCommand(): Command {
  return buildRestoreProvisionsCommand();
}

function buildRestoreProvisionsCommand(): Command {
  return new Command("restore-provisions")
    .description("Restore provisions.json from a dated backup (BCP/DR)")
    .option(
      "--from <date>",
      "Restore from a specific backup date (YYYY-MM-DD). Defaults to most recent backup.",
    )
    .option(
      "--from-audit-log",
      "Rebuild missing provision records from the HMAC-chained audit log " +
        "(~/.assignee/audit/audit.log). Reads `apply_resource_created` events " +
        "and appends a reconstructed record for any ARN absent from " +
        "provisions.json. Cannot be combined with --from <date>.",
    )
    .option(
      "--json",
      "Emit machine-readable JSON to stdout instead of human-readable text",
    )
    .action(
      async (opts: {
        from?: string;
        fromAuditLog?: boolean;
        json?: boolean;
      }) => {
        // Mutually-exclusive validation BEFORE any I/O — surfaces the
        // configuration error fast and prevents accidental double-write
        // attempts. Thrown as `AssigneeError(USAGE_ERROR)` so the top-level
        // unhandled-error catch in `apps/cli/src/index.ts` (via
        // `errorToExitCode`) maps it to `ProcessExitCode.USAGE_ERROR` (73).
        // This matches the project convention documented at
        // `apps/cli/src/utils/exit-code.ts:26-28` and modelled by `init.ts`.
        if (opts.from !== undefined && opts.fromAuditLog === true) {
          const message =
            "--from <date> and --from-audit-log are mutually exclusive. " +
            "Pick one: --from to replay a backup, --from-audit-log to rebuild " +
            "missing records from the audit log.";
          // JSON-mode operators still get the structured envelope on stdout;
          // emit it BEFORE throwing so the AssigneeError surface (handled by
          // the top-level catch) drives the exit code while the JSON consumer
          // still has a parseable record describing the failure.
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({
                restored: false,
                mode: "invalid",
                message,
              }) + "\n",
            );
          }
          throw new AssigneeError(message, ErrorCode.USAGE_ERROR);
        }

        // Branch A: --from-audit-log → rebuild from audit log.
        if (opts.fromAuditLog === true) {
          const auditResult = await restoreFromAuditLog();
          if (!auditResult.ok) {
            if (opts.json) {
              process.stdout.write(
                JSON.stringify({
                  restored: false,
                  mode: "from-audit-log",
                  rebuiltCount: auditResult.rebuiltCount,
                  skippedCount: auditResult.skippedCount,
                  alreadyPresentCount: auditResult.alreadyPresentCount,
                  inBatchDuplicateCount: auditResult.inBatchDuplicateCount,
                  candidateCount: auditResult.candidateCount,
                  durationMs: auditResult.durationMs,
                  errorCode: auditResult.errorCode,
                  message: auditResult.message,
                }) + "\n",
              );
            } else {
              process.stderr.write(`error: ${auditResult.message}\n`);
            }
            process.exitCode = ProcessExitCode.GENERIC_ERROR;
            return;
          }
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({
                restored: true,
                mode: "from-audit-log",
                rebuiltCount: auditResult.rebuiltCount,
                skippedCount: auditResult.skippedCount,
                alreadyPresentCount: auditResult.alreadyPresentCount,
                inBatchDuplicateCount: auditResult.inBatchDuplicateCount,
                candidateCount: auditResult.candidateCount,
                durationMs: auditResult.durationMs,
                safetyBackup: auditResult.safetyBackupPath
                  ? path.basename(auditResult.safetyBackupPath)
                  : "",
                skips: auditResult.skips,
                message: auditResult.message,
              }) + "\n",
            );
          } else {
            process.stdout.write(`${auditResult.message}\n`);
          }
          return;
        }

        // Branch B: classic dated-backup restore.
        const result = await restoreProvisions({ from: opts.from });

        if (!result.restored) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({
                restored: false,
                mode: "from-backup",
                backup: result.sourcePath ?? "",
                message: result.message,
              }) + "\n",
            );
          } else {
            process.stderr.write(`error: ${result.message}\n`);
          }
          process.exitCode = ProcessExitCode.GENERIC_ERROR;
          return;
        }

        // Extract the backup filename for the JSON envelope.
        const backupBasename = result.sourcePath
          ? path.basename(result.sourcePath)
          : "";

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({
              restored: true,
              mode: "from-backup",
              backup: backupBasename,
              message: result.message,
            }) + "\n",
          );
        } else {
          process.stdout.write(`${result.message}\n`);
        }
      },
    );
}

/**
 * Production-singleton instance, built once at module load.  Apps that
 * compose the CLI program tree (e.g. `apps/cli/src/index.ts`) consume
 * this; tests that need fresh option state per assertion call
 * `createRestoreProvisionsCommand()` instead.
 */
export const restoreProvisionsCommand = buildRestoreProvisionsCommand();
