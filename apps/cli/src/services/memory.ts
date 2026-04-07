/**
 * MemoryService — JSON-file backed memory for provisions, failures, and patterns.
 *
 * Shared service: this story (19.3) implements provision methods.
 * Stories 19.4 and 19.5 add failure and pattern methods.
 *
 * Design rules:
 * - Reads return empty arrays on failure (graceful degradation).
 * - Writes are fire-and-forget — callers should catch and log, never throw.
 * - Constructor-injected directory for test isolation.
 *
 * @see Story 19.3, 19.4, 19.5
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import {
  ASSIGNEE_DIR,
  MEMORY_DEDUP_THRESHOLD_MS,
  PROVISIONS_FILE,
  FAILURES_FILE,
  FileName,
} from "../config/constants.js";
import {
  ProvisionLogSchema,
  FailureLogSchema,
  PatternLogSchema,
  type ProvisionRecord,
  type FailureRecord,
  type PatternRecord,
  safeTry,
} from "@assignee/core";

const MEMORY_DIR = path.join(os.homedir(), ASSIGNEE_DIR, "memory");

export class MemoryService {
  constructor(private readonly dir: string = MEMORY_DIR) {}

  private filePath(name: string): string {
    return path.join(this.dir, name);
  }

  private async ensureDir(): Promise<void> {
    // 0o700 — provision/failure/pattern logs may include resource ARNs and
    // user intents that should not be world-readable on shared systems.
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  /**
   * Back up a corrupt file before returning empty data.
   * Prevents silent total data loss when JSON.parse fails on a non-empty file.
   * The corrupt file is copied to `{filename}.corrupt.{timestamp}` so the user
   * can attempt manual recovery.
   *
   * @see EC-29
   */
  private async backupCorruptFile(fileName: string): Promise<void> {
    const filePath = this.filePath(fileName);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 0) {
        const ts = Date.now();
        const backupPath = `${filePath}.corrupt.${ts}`;
        await fs.copyFile(filePath, backupPath);
        process.stderr.write(
          `WARNING: ${fileName} appears corrupt. Backup saved to ${fileName}.corrupt.${ts}. Previous data may be recoverable.\n`,
        );
      }
    } catch {
      // File doesn't exist or can't be stat'd — nothing to back up
    }
  }

  /**
   * Atomically write a file: write to a temp file first, then rename.
   * Prevents corruption from partial writes / crashes.
   */
  private async atomicWrite(filePath: string, data: string): Promise<void> {
    // Random suffix avoids PID collisions when two concurrent writers
    // (or two processes with recycled PIDs) target the same file.
    const tmpPath = filePath + ".tmp." + randomBytes(8).toString("hex");
    // 0o600 — these JSON files (provisions / failures / patterns) may
    // contain user intents and resource ARNs and should not be readable
    // by other local users. chmod the final path as defence-in-depth in
    // case rename() inherits a wider mode from a pre-existing file.
    await fs.writeFile(tmpPath, data, { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tmpPath, filePath);
    try {
      await fs.chmod(filePath, 0o600);
    } catch {
      // Best-effort on filesystems that don't support chmod (Windows etc.)
    }
  }

  /**
   * Acquire a simple advisory lock file. Returns true if acquired.
   * Uses O_CREAT|O_EXCL for atomic creation to prevent TOCTOU race conditions.
   * Skips if a lock exists and is less than 10 seconds old.
   */
  private async acquireLock(filePath: string): Promise<boolean> {
    const lockPath = filePath + ".lock";
    try {
      // Check for stale locks first
      const stat = await fs.stat(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < MEMORY_DEDUP_THRESHOLD_MS) {
        // Lock is fresh — another writer is active
        return false;
      }
      // Stale lock — remove it
      await fs.unlink(lockPath).catch(() => {});
    } catch {
      // No lock file — proceed to create
    }
    // Use O_CREAT|O_EXCL|O_WRONLY for atomic lock creation.
    // If another process creates the file between stat and open, this will throw EEXIST.
    try {
      const { constants } = await import("node:fs");
      const fh = await fs.open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      );
      await fh.write(String(process.pid));
      await fh.close();
      return true;
    } catch {
      // EEXIST or other error — another process won the race
      return false;
    }
  }

  /**
   * Release an advisory lock file.
   */
  private async releaseLock(filePath: string): Promise<void> {
    const lockPath = filePath + ".lock";
    await fs.unlink(lockPath).catch(() => {});
  }

  // --- Provisions (append-only) ---

  async readProvisions(): Promise<ProvisionRecord[]> {
    const [err, raw] = await safeTry(
      fs.readFile(this.filePath(PROVISIONS_FILE), "utf-8"),
    );
    if (err) return [];
    try {
      const parsed = ProvisionLogSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      // Valid JSON but wrong schema — back up before returning empty
      await this.backupCorruptFile(PROVISIONS_FILE);
      return [];
    } catch {
      // Invalid JSON — back up the corrupt file before returning empty
      await this.backupCorruptFile(PROVISIONS_FILE);
      return [];
    }
  }

  async appendProvision(record: ProvisionRecord): Promise<void> {
    await this.ensureDir();
    const target = this.filePath(PROVISIONS_FILE);
    const acquired = await this.acquireLock(target);
    if (!acquired) {
      process.stderr.write(
        "WARNING: Could not acquire lock for provisions.json — skipping write to prevent corruption.\n",
      );
      return;
    }
    try {
      const existing = await this.readProvisions();
      existing.push(record);
      await this.atomicWrite(target, JSON.stringify(existing, null, 2));
    } finally {
      await this.releaseLock(target);
    }
  }

  // --- Failures (append-only) — stub for Story 19.4 ---

  async readFailures(): Promise<FailureRecord[]> {
    const [err, raw] = await safeTry(
      fs.readFile(this.filePath(FAILURES_FILE), "utf-8"),
    );
    if (err) return [];
    try {
      const parsed = FailureLogSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      await this.backupCorruptFile(FAILURES_FILE);
      return [];
    } catch {
      await this.backupCorruptFile(FAILURES_FILE);
      return [];
    }
  }

  async appendFailure(record: FailureRecord): Promise<void> {
    await this.ensureDir();
    const target = this.filePath(FAILURES_FILE);
    const acquired = await this.acquireLock(target);
    if (!acquired) {
      process.stderr.write(
        "WARNING: Could not acquire lock for failures.json — skipping write to prevent corruption.\n",
      );
      return;
    }
    try {
      const existing = await this.readFailures();
      existing.push(record);
      await this.atomicWrite(target, JSON.stringify(existing, null, 2));
    } finally {
      await this.releaseLock(target);
    }
  }

  /**
   * Remove all failure records for a given resource type.
   * Called after a successful provision so stale errors are not surfaced.
   *
   * @see Story 20.13
   */
  async clearFailuresForType(resourceType: string): Promise<void> {
    await this.ensureDir();
    const target = this.filePath(FAILURES_FILE);
    const acquired = await this.acquireLock(target);
    if (!acquired) {
      process.stderr.write(
        "WARNING: Could not acquire lock for failures.json — skipping write to prevent corruption.\n",
      );
      return;
    }
    try {
      const existing = await this.readFailures();
      const filtered = existing.filter((f) => f.resourceType !== resourceType);
      // Skip write if nothing changed
      if (filtered.length === existing.length) return;
      await this.atomicWrite(target, JSON.stringify(filtered, null, 2));
    } finally {
      await this.releaseLock(target);
    }
  }

  // --- Patterns (upsert) — stub for Story 19.5 ---

  async readPatterns(): Promise<PatternRecord[]> {
    const [err, raw] = await safeTry(
      fs.readFile(this.filePath(FileName.PATTERNS), "utf-8"),
    );
    if (err) return [];
    try {
      const parsed = PatternLogSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      await this.backupCorruptFile(FileName.PATTERNS);
      return [];
    } catch {
      await this.backupCorruptFile(FileName.PATTERNS);
      return [];
    }
  }

  async upsertPattern(record: PatternRecord): Promise<void> {
    await this.ensureDir();
    const target = this.filePath(FileName.PATTERNS);
    const acquired = await this.acquireLock(target);
    if (!acquired) {
      process.stderr.write(
        "WARNING: Could not acquire lock for patterns.json — skipping write to prevent corruption.\n",
      );
      return;
    }
    try {
      const existing = await this.readPatterns();
      const idx = existing.findIndex((p) => p.pattern === record.pattern);
      if (idx >= 0) {
        // Update existing — increment count, update options and lastUsed
        existing[idx] = {
          ...existing[idx],
          pattern: record.pattern,
          optionsSelected: record.optionsSelected,
          count: existing[idx]!.count + 1,
          lastUsed: record.lastUsed,
        };
      } else {
        // New pattern — insert with count = 1
        existing.push({ ...record, count: 1 });
      }
      await this.atomicWrite(target, JSON.stringify(existing, null, 2));
    } finally {
      await this.releaseLock(target);
    }
  }
  // --- Rotation (trim oldest records to stay within caps) ---

  /**
   * Rotate provisions: keep only the most recent `maxRecords` entries.
   * If a preserveFilter is provided, records matching the filter are never removed
   * even if they exceed maxRecords — only older non-preserved records are trimmed.
   * @returns Number of records removed.
   */
  async rotateProvisions(
    maxRecords = 200,
    preserveFilter?: (record: ProvisionRecord) => boolean,
  ): Promise<number> {
    const existing = await this.readProvisions();
    if (existing.length <= maxRecords) return 0;

    let trimmed: ProvisionRecord[];
    if (preserveFilter) {
      // Split into preserved (must keep) and candidates (can trim)
      const preserved: ProvisionRecord[] = [];
      const candidates: ProvisionRecord[] = [];
      for (const record of existing) {
        if (preserveFilter(record)) {
          preserved.push(record);
        } else {
          candidates.push(record);
        }
      }
      // Keep the most recent candidates up to the remaining budget
      const budget = Math.max(0, maxRecords - preserved.length);
      const keptCandidates = candidates.slice(-budget);
      trimmed = [...keptCandidates, ...preserved].sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
    } else {
      trimmed = existing.slice(-maxRecords);
    }

    const removed = existing.length - trimmed.length;
    if (removed === 0) return 0;

    await this.ensureDir();
    const target = this.filePath(PROVISIONS_FILE);
    const acquired = await this.acquireLock(target);
    if (!acquired) {
      process.stderr.write(
        "WARNING: Could not acquire lock for provisions.json — skipping rotation to prevent corruption.\n",
      );
      return 0;
    }
    try {
      await this.atomicWrite(target, JSON.stringify(trimmed, null, 2));
    } finally {
      await this.releaseLock(target);
    }
    return removed;
  }

  /**
   * Rotate failures: keep only the most recent `maxRecords` entries.
   * @returns Number of records removed.
   */
  async rotateFailures(maxRecords = 100): Promise<number> {
    const existing = await this.readFailures();
    if (existing.length <= maxRecords) return 0;
    const removed = existing.length - maxRecords;
    const trimmed = existing.slice(-maxRecords);
    await this.ensureDir();
    const target = this.filePath(FAILURES_FILE);
    const acquired = await this.acquireLock(target);
    if (!acquired) {
      process.stderr.write(
        "WARNING: Could not acquire lock for failures.json — skipping rotation to prevent corruption.\n",
      );
      return 0;
    }
    try {
      await this.atomicWrite(target, JSON.stringify(trimmed, null, 2));
    } finally {
      await this.releaseLock(target);
    }
    return removed;
  }

  /**
   * Rotate patterns: keep only the most recent `maxRecords` entries.
   * @returns Number of records removed.
   */
  async rotatePatterns(maxRecords = 100): Promise<number> {
    const existing = await this.readPatterns();
    if (existing.length <= maxRecords) return 0;
    const removed = existing.length - maxRecords;
    const trimmed = existing.slice(-maxRecords);
    await this.ensureDir();
    const target = this.filePath(FileName.PATTERNS);
    const acquired = await this.acquireLock(target);
    if (!acquired) {
      process.stderr.write(
        "WARNING: Could not acquire lock for patterns.json — skipping rotation to prevent corruption.\n",
      );
      return 0;
    }
    try {
      await this.atomicWrite(target, JSON.stringify(trimmed, null, 2));
    } finally {
      await this.releaseLock(target);
    }
    return removed;
  }
}

/** Default singleton instance for production use. Tests can instantiate with a temp dir. */
export const defaultMemoryService = new MemoryService();
