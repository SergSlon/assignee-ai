/**
 * W4-04 (Epic 100 Round 3) — provisions.json BCP/DR backup script.
 *
 * Copies `~/.assignee/memory/provisions.json` to
 * `~/.assignee/backups/provisions-YYYY-MM-DD.json` and rotates backups
 * older than 7 days.
 *
 * Usage:
 *   pnpm tsx scripts/backup-provisions.ts [--dir <memory-dir>] [--backup-dir <backup-dir>] [--retention-days <N>]
 *
 * Options:
 *   --dir <path>              Override memory directory (default: ~/.assignee/memory/)
 *   --backup-dir <path>       Override backup directory (default: ~/.assignee/backups/)
 *   --retention-days <N>      Number of days to retain backups (default: 7)
 *
 * Sensitive-marker note:
 *   provisions.json on disk is already post-scrub (W1-01 integration in
 *   memory-recorder.ts applies `stripSensitiveFromElicited` +
 *   `redactAccountIdsInPrompt` before the record reaches the file). This
 *   script copies the file as-is — no fresh scrubbing is performed.
 *   The backup therefore inherits the same privacy guarantees as the source.
 *
 * Security:
 *   - Backup files are written with 0o600 (owner rw only).
 *   - Backup is a copy — never a move. Source file is never mutated.
 *   - Atomic write: temp file + rename prevents corrupt backups on crash.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Constants ─────────────────────────────────────────────────────────

const DEFAULT_MEMORY_DIR = path.join(os.homedir(), ".assignee", "memory");
const DEFAULT_BACKUP_DIR = path.join(os.homedir(), ".assignee", "backups");
const DEFAULT_RETENTION_DAYS = 7;
const PROVISIONS_FILE = "provisions.json";
const BACKUP_PREFIX = "provisions-";

// ── CLI args ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  memoryDir: string;
  backupDir: string;
  retentionDays: number;
} {
  let memoryDir = DEFAULT_MEMORY_DIR;
  let backupDir = DEFAULT_BACKUP_DIR;
  let retentionDays = DEFAULT_RETENTION_DAYS;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--dir" && argv[i + 1]) {
      memoryDir = argv[++i];
    } else if (argv[i] === "--backup-dir" && argv[i + 1]) {
      backupDir = argv[++i];
    } else if (argv[i] === "--retention-days" && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!isNaN(n) && n > 0) retentionDays = n;
    }
  }

  return { memoryDir, backupDir, retentionDays };
}

// ── Date helpers ──────────────────────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Parse YYYY-MM-DD from a backup filename. Returns null on mismatch. */
function parseDateFromFilename(name: string): Date | null {
  if (!name.startsWith(BACKUP_PREFIX) || !name.endsWith(".json")) return null;
  const datePart = name.slice(BACKUP_PREFIX.length, -".json".length);
  const d = new Date(`${datePart}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

// ── Atomic write ─────────────────────────────────────────────────────

function atomicWriteSync(destPath: string, content: Buffer): void {
  const tmpPath = `${destPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, content, { mode: 0o600 });
    fs.renameSync(tmpPath, destPath);
    try {
      fs.chmodSync(destPath, 0o600);
    } catch {
      // Best-effort on non-POSIX (e.g. some Windows configurations).
    }
  } catch (err) {
    // Clean up temp file on failure.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors.
    }
    throw err;
  }
}

// ── Main ──────────────────────────────────────────────────────────────

function main(): void {
  const { memoryDir, backupDir, retentionDays } = parseArgs(process.argv);

  const sourceFile = path.join(memoryDir, PROVISIONS_FILE);

  // Verify the source file exists before proceeding.
  if (!fs.existsSync(sourceFile)) {
    console.log(
      `[backup-provisions] No provisions.json found at ${sourceFile}. Nothing to back up.`,
    );
    process.exit(0);
  }

  // Ensure backup directory exists with restricted permissions.
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  // Read source.
  const content = fs.readFileSync(sourceFile);

  // Write backup (idempotent — overwrites today's backup if it exists).
  const backupName = `${BACKUP_PREFIX}${todayIso()}.json`;
  const backupFile = path.join(backupDir, backupName);
  atomicWriteSync(backupFile, content);
  console.log(`[backup-provisions] Backup written: ${backupFile}`);

  // Rotate: delete backups older than retentionDays.
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  let pruned = 0;
  for (const name of fs.readdirSync(backupDir)) {
    const d = parseDateFromFilename(name);
    if (d && d < cutoff) {
      fs.unlinkSync(path.join(backupDir, name));
      pruned++;
    }
  }

  if (pruned > 0) {
    console.log(
      `[backup-provisions] Pruned ${pruned} backup(s) older than ${retentionDays} days.`,
    );
  }
}

main();
