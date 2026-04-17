/**
 * Log-directory resolution + daily filename formatting + rotation helper.
 *
 * Lifted from `apps/cli/src/utils/logger/paths.ts` in Story 50-4
 * Wave 5 Pass A.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** Environment variable to redirect persistent logs (used by tests). */
const LOG_DIR_ENV = "ASSIGNEE_LOG_DIR";

/**
 * Soft size cap for the daily log file. When the active file exceeds this
 * size, subsequent writes go to a numbered rotation (cli-YYYY-MM-DD.<n>.jsonl).
 */
export const LOG_FILE_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;
let logFileSizeLimitBytes = LOG_FILE_SIZE_LIMIT_BYTES;

/**
 * Module-level cache of directories we've already created via mkdirSync.
 * Process-scoped: a long compound apply emits thousands of events to the
 * same dir and the mkdirSync overhead is wasted I/O. (REG-N9)
 */
const ensuredDirs = new Set<string>();

/** Test-only helpers. */
export function setLogFileSizeLimitForTests(limitBytes: number): void {
  logFileSizeLimitBytes = limitBytes;
}
export function resetLogFileSizeLimitForTests(): void {
  logFileSizeLimitBytes = LOG_FILE_SIZE_LIMIT_BYTES;
}
export function clearEnsuredDirCacheForTests(): void {
  ensuredDirs.clear();
}

/**
 * Resolve the directory where error/warn events should be persisted.
 * Honors ASSIGNEE_LOG_DIR (used by tests), otherwise falls back to
 * ~/.assignee/logs.
 */
export function resolveLogDir(): string {
  const override = process.env[LOG_DIR_ENV];
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".assignee", "logs");
}

/** Exposed for tests and for the `clean` command. */
export function getLogDir(): string {
  return resolveLogDir();
}

/** Format a Date as YYYY-MM-DD in UTC for the daily log file name. */
export function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Resolve the active log file path for `day`, rotating to a numbered suffix
 * if the base file exceeds the size limit. Walks counters until it finds a
 * file under the cap (or one that doesn't exist yet). Never deletes old files
 * during rotation — retention is handled by pruneOldLogs / clean --logs.
 */
export function resolveActiveLogFile(dir: string, day: string): string {
  const baseName = `cli-${day}.jsonl`;
  const basePath = path.join(dir, baseName);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(basePath);
  } catch {
    return basePath;
  }
  if (stat.size < logFileSizeLimitBytes) return basePath;

  for (let n = 1; n < 10_000; n++) {
    const rotated = path.join(dir, `cli-${day}.${n}.jsonl`);
    let rotStat: fs.Stats | undefined;
    try {
      rotStat = fs.statSync(rotated);
    } catch {
      return rotated;
    }
    if (rotStat.size < logFileSizeLimitBytes) return rotated;
  }
  // Pathological: 10 000 rotations all full. Fall back to the last one.
  return path.join(dir, `cli-${day}.9999.jsonl`);
}

/**
 * Ensure `dir` exists (process-cached mkdirSync) and return it.
 * REG-N9: skip the syscall once we've already created `dir` this process.
 */
export function ensureLogDirCached(dir: string): void {
  if (ensuredDirs.has(dir)) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  ensuredDirs.add(dir);
}
