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
import { ProcessExitCode } from "../constants/errors.js";

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
    // Validate date format.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.from)) {
      return {
        restored: false,
        sourcePath: null,
        targetPath,
        safetyBackupPath: null,
        message: `Invalid date format: "${options.from}". Expected YYYY-MM-DD.`,
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

export const restoreProvisionsCommand = new Command("restore-provisions")
  .description("Restore provisions.json from a dated backup (BCP/DR)")
  .option(
    "--from <date>",
    "Restore from a specific backup date (YYYY-MM-DD). Defaults to most recent backup.",
  )
  .option(
    "--json",
    "Emit machine-readable JSON to stdout instead of human-readable text",
  )
  .action(async (opts: { from?: string; json?: boolean }) => {
    const result = await restoreProvisions({ from: opts.from });

    if (!result.restored) {
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({
            restored: false,
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
          backup: backupBasename,
          message: result.message,
        }) + "\n",
      );
    } else {
      process.stdout.write(`${result.message}\n`);
    }
  });
