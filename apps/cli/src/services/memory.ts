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
import {
  ProvisionLogSchema,
  FailureLogSchema,
  PatternLogSchema,
  type ProvisionRecord,
  type FailureRecord,
  type PatternRecord,
  safeTry,
} from "@assignee/core";

const MEMORY_DIR = path.join(os.homedir(), ".assignee", "memory");

export class MemoryService {
  constructor(private readonly dir: string = MEMORY_DIR) {}

  private filePath(name: string): string {
    return path.join(this.dir, name);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
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
    const tmpPath = filePath + ".tmp." + process.pid;
    await fs.writeFile(tmpPath, data, "utf-8");
    await fs.rename(tmpPath, filePath);
  }

  /**
   * Acquire a simple advisory lock file. Returns true if acquired.
   * Skips if a lock exists and is less than 10 seconds old.
   */
  private async acquireLock(filePath: string): Promise<boolean> {
    const lockPath = filePath + ".lock";
    try {
      const stat = await fs.stat(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < 10_000) {
        // Lock is fresh — another writer is active
        return false;
      }
      // Stale lock — remove it
      await fs.unlink(lockPath).catch(() => {});
    } catch {
      // No lock file — proceed
    }
    await fs.writeFile(lockPath, String(process.pid), "utf-8");
    return true;
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
      fs.readFile(this.filePath("provisions.json"), "utf-8"),
    );
    if (err) return [];
    try {
      const parsed = ProvisionLogSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      // Valid JSON but wrong schema — back up before returning empty
      await this.backupCorruptFile("provisions.json");
      return [];
    } catch {
      // Invalid JSON — back up the corrupt file before returning empty
      await this.backupCorruptFile("provisions.json");
      return [];
    }
  }

  async appendProvision(record: ProvisionRecord): Promise<void> {
    await this.ensureDir();
    const target = this.filePath("provisions.json");
    const acquired = await this.acquireLock(target);
    try {
      const existing = await this.readProvisions();
      existing.push(record);
      await this.atomicWrite(target, JSON.stringify(existing, null, 2));
    } finally {
      if (acquired) await this.releaseLock(target);
    }
  }

  // --- Failures (append-only) — stub for Story 19.4 ---

  async readFailures(): Promise<FailureRecord[]> {
    const [err, raw] = await safeTry(
      fs.readFile(this.filePath("failures.json"), "utf-8"),
    );
    if (err) return [];
    try {
      const parsed = FailureLogSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      await this.backupCorruptFile("failures.json");
      return [];
    } catch {
      await this.backupCorruptFile("failures.json");
      return [];
    }
  }

  async appendFailure(record: FailureRecord): Promise<void> {
    await this.ensureDir();
    const target = this.filePath("failures.json");
    const acquired = await this.acquireLock(target);
    try {
      const existing = await this.readFailures();
      existing.push(record);
      await this.atomicWrite(target, JSON.stringify(existing, null, 2));
    } finally {
      if (acquired) await this.releaseLock(target);
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
    const existing = await this.readFailures();
    const filtered = existing.filter((f) => f.resourceType !== resourceType);
    // Skip write if nothing changed
    if (filtered.length === existing.length) return;
    await fs.writeFile(
      this.filePath("failures.json"),
      JSON.stringify(filtered, null, 2),
      "utf-8",
    );
  }

  // --- Patterns (upsert) — stub for Story 19.5 ---

  async readPatterns(): Promise<PatternRecord[]> {
    const [err, raw] = await safeTry(
      fs.readFile(this.filePath("patterns.json"), "utf-8"),
    );
    if (err) return [];
    try {
      const parsed = PatternLogSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      await this.backupCorruptFile("patterns.json");
      return [];
    } catch {
      await this.backupCorruptFile("patterns.json");
      return [];
    }
  }

  async upsertPattern(record: PatternRecord): Promise<void> {
    await this.ensureDir();
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
    await fs.writeFile(
      this.filePath("patterns.json"),
      JSON.stringify(existing, null, 2),
      "utf-8",
    );
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
    await fs.writeFile(
      this.filePath("provisions.json"),
      JSON.stringify(trimmed, null, 2),
      "utf-8",
    );
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
    await fs.writeFile(
      this.filePath("failures.json"),
      JSON.stringify(trimmed, null, 2),
      "utf-8",
    );
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
    await fs.writeFile(
      this.filePath("patterns.json"),
      JSON.stringify(trimmed, null, 2),
      "utf-8",
    );
    return removed;
  }
}

/** Default singleton instance for production use. Tests can instantiate with a temp dir. */
export const defaultMemoryService = new MemoryService();
