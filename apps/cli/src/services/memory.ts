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

  // --- Provisions (append-only) ---

  async readProvisions(): Promise<ProvisionRecord[]> {
    const [err, raw] = await safeTry(
      fs.readFile(this.filePath("provisions.json"), "utf-8"),
    );
    if (err) return [];
    try {
      const parsed = ProvisionLogSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  async appendProvision(record: ProvisionRecord): Promise<void> {
    await this.ensureDir();
    const existing = await this.readProvisions();
    existing.push(record);
    await fs.writeFile(
      this.filePath("provisions.json"),
      JSON.stringify(existing, null, 2),
      "utf-8",
    );
  }

  // --- Failures (append-only) — stub for Story 19.4 ---

  async readFailures(): Promise<FailureRecord[]> {
    const [err, raw] = await safeTry(
      fs.readFile(this.filePath("failures.json"), "utf-8"),
    );
    if (err) return [];
    try {
      const parsed = FailureLogSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  async appendFailure(record: FailureRecord): Promise<void> {
    await this.ensureDir();
    const existing = await this.readFailures();
    existing.push(record);
    await fs.writeFile(
      this.filePath("failures.json"),
      JSON.stringify(existing, null, 2),
      "utf-8",
    );
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
      return parsed.success ? parsed.data : [];
    } catch {
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
