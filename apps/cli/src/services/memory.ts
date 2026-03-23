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
}

/** Default singleton instance for production use. Tests can instantiate with a temp dir. */
export const defaultMemoryService = new MemoryService();
