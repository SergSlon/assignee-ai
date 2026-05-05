/**
 * MemoryService — JSON-file backed memory for provisions, failures, and patterns.
 *
 * Wave 6d F5: extracted from memory.ts into ./service.ts. Base filesystem
 * primitives (atomic write, advisory lock, corrupt-file backup) live in
 * ./file-store.ts. Rotation helpers live in ./rotation.ts (mixed in via
 * delegation).
 *
 * Design rules:
 * - Reads return empty arrays on failure (graceful degradation).
 * - Writes are fire-and-forget — callers should catch and log, never throw.
 * - Constructor-injected directory for test isolation.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ASSIGNEE_DIR, FileName } from "../../config/constants/paths.js";
import {
  ProvisionLogSchema,
  FailureLogSchema,
  PatternLogSchema,
  ProvisionRecordSchema,
  FailureRecordSchema,
  PatternRecordSchema,
  type ProvisionRecord,
  type FailureRecord,
  type PatternRecord,
} from "../../schema/memory.js";
import type { ZodTypeAny } from "zod";

/**
 * Drop schema-failing records instead of nuking the whole array.
 * Returns the surviving records + count dropped (for telemetry).
 *
 * Bug history: a SINGLE bad record (e.g. a stray test fixture with
 * `runId='test-run-failure-001'` that fails uuid validation) used to
 * fail safeParse on the entire array, triggering backupCorruptFile and
 * returning [] — losing all valid records. Per-record validation
 * preserves valid data and only quarantines the bad rows.
 */
function filterValidRecords<T>(
  raw: unknown,
  recordSchema: ZodTypeAny,
): { valid: T[]; dropped: number } {
  if (!Array.isArray(raw)) return { valid: [], dropped: 0 };
  const valid: T[] = [];
  let dropped = 0;
  for (const r of raw) {
    const parsed = recordSchema.safeParse(r);
    if (parsed.success) valid.push(parsed.data as T);
    else dropped++;
  }
  return { valid, dropped };
}
import { safeTry } from "../../types/result.js";
import { FileStore } from "./file-store.js";
import { rotateRecords, type RotationPreserveFilter } from "./rotation.js";

const MEMORY_DIR = path.join(os.homedir(), ASSIGNEE_DIR, "memory");

export class MemoryService extends FileStore {
  constructor(dir: string = MEMORY_DIR) {
    super(dir);
  }

  // --- Provisions (append-only) ---

  async readProvisions(): Promise<ProvisionRecord[]> {
    const [err, raw] = await safeTry(
      fs.readFile(this.filePath(FileName.PROVISIONS), "utf-8"),
    );
    if (err) return [];
    try {
      const json = JSON.parse(raw);
      const fast = ProvisionLogSchema.safeParse(json);
      if (fast.success) return fast.data;
      const { valid, dropped } = filterValidRecords<ProvisionRecord>(
        json,
        ProvisionRecordSchema,
      );
      if (dropped > 0) {
        process.stderr.write(
          `WARNING: ${FileName.PROVISIONS}: dropped ${dropped} schema-failing record(s); ${valid.length} valid record(s) preserved.\n`,
        );
      }
      return valid;
    } catch {
      await this.backupCorruptFile(FileName.PROVISIONS);
      return [];
    }
  }

  /**
   * SSH-bundle Story iv — read-side filter that returns the single
   * provision record matching a `runId` (UUID-shaped) or a `resourceArn`
   * (full ARN — `arn:aws…:`). Used by `assignee describe` to look up the
   * apply-time snapshot before re-rendering the apply-success line with
   * a fresh DescribeInstances overlay.
   *
   * Polymorphism rule: if `runIdOrArn` matches the partition-aware ARN
   * regex (`/^arn:aws[\w-]*:/`, covering aws / aws-us-gov / aws-cn —
   * see `feedback_partition_aware_arn_matching` memory) we filter on
   * `resourceArn`; otherwise we filter on `runId`. The match is exact —
   * no prefix / suffix matching — so a stray substring of one record's
   * ARN can never alias another. Returns `undefined` (not an error)
   * when no record matches; the caller surfaces a friendly
   * "No provision record found" message.
   *
   * Reuses `readProvisions()` for the underlying read (with all of its
   * Zod validation + per-record drop semantics), so this helper does
   * NOT introduce a new persistence path — it's a thin in-memory
   * filter on top of the existing array. Backwards-compatible against
   * pre-Story-iv records that lack `publicIpAddressAtApply` because the
   * Zod field is `.optional()`.
   */
  async readProvisionRecord(
    runIdOrArn: string,
  ): Promise<ProvisionRecord | undefined> {
    if (!runIdOrArn) return undefined;
    // Trim before any matching: copy-pasted ARNs / runIds frequently
    // pick up leading or trailing whitespace from the terminal, and
    // routing on the un-trimmed input would silently fall through to
    // the runId branch (the ARN regex would miss the leading space)
    // and return undefined for an otherwise-valid resource ARN.
    const input = runIdOrArn.trim();
    if (input.length === 0) return undefined;
    const records = await this.readProvisions();
    // Partition-aware ARN regex (aws, aws-us-gov, aws-cn) — see
    // `feedback_partition_aware_arn_matching` memory.
    const isArn = /^arn:aws[\w-]*:/.test(input);
    if (isArn) {
      return records.find((r) => r.resourceArn === input);
    }
    return records.find((r) => r.runId === input);
  }

  async appendProvision(record: ProvisionRecord): Promise<void> {
    await this.ensureDir();
    const target = this.filePath(FileName.PROVISIONS);
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

  // --- Failures (append-only) ---

  async readFailures(): Promise<FailureRecord[]> {
    const [err, raw] = await safeTry(
      fs.readFile(this.filePath(FileName.FAILURES), "utf-8"),
    );
    if (err) return [];
    try {
      const json = JSON.parse(raw);
      const fast = FailureLogSchema.safeParse(json);
      if (fast.success) return fast.data;
      const { valid, dropped } = filterValidRecords<FailureRecord>(
        json,
        FailureRecordSchema,
      );
      if (dropped > 0) {
        process.stderr.write(
          `WARNING: ${FileName.FAILURES}: dropped ${dropped} schema-failing record(s); ${valid.length} valid record(s) preserved.\n`,
        );
      }
      return valid;
    } catch {
      await this.backupCorruptFile(FileName.FAILURES);
      return [];
    }
  }

  async appendFailure(record: FailureRecord): Promise<void> {
    await this.ensureDir();
    const target = this.filePath(FileName.FAILURES);
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
   */
  async clearFailuresForType(resourceType: string): Promise<void> {
    await this.ensureDir();
    const target = this.filePath(FileName.FAILURES);
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
      if (filtered.length === existing.length) return;
      await this.atomicWrite(target, JSON.stringify(filtered, null, 2));
    } finally {
      await this.releaseLock(target);
    }
  }

  // --- Patterns (upsert) ---

  async readPatterns(): Promise<PatternRecord[]> {
    const [err, raw] = await safeTry(
      fs.readFile(this.filePath(FileName.PATTERNS), "utf-8"),
    );
    if (err) return [];
    try {
      const json = JSON.parse(raw);
      const fast = PatternLogSchema.safeParse(json);
      if (fast.success) return fast.data;
      const { valid, dropped } = filterValidRecords<PatternRecord>(
        json,
        PatternRecordSchema,
      );
      if (dropped > 0) {
        process.stderr.write(
          `WARNING: ${FileName.PATTERNS}: dropped ${dropped} schema-failing record(s); ${valid.length} valid record(s) preserved.\n`,
        );
      }
      return valid;
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
        existing[idx] = {
          ...existing[idx],
          pattern: record.pattern,
          optionsSelected: record.optionsSelected,
          count: existing[idx]!.count + 1,
          lastUsed: record.lastUsed,
        };
      } else {
        existing.push({ ...record, count: 1 });
      }
      await this.atomicWrite(target, JSON.stringify(existing, null, 2));
    } finally {
      await this.releaseLock(target);
    }
  }

  // --- Destroyed ARNs (append-only set, for post-destroy list filtering) ---

  async readDestroyedArns(): Promise<Set<string>> {
    const [err, raw] = await safeTry(
      fs.readFile(this.filePath(FileName.DESTROYED_ARNS), "utf-8"),
    );
    if (err) return new Set();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed as string[]);
      return new Set();
    } catch {
      return new Set();
    }
  }

  async appendDestroyedArn(arn: string): Promise<void> {
    if (!arn) return;
    await this.ensureDir();
    const target = this.filePath(FileName.DESTROYED_ARNS);
    const acquired = await this.acquireLock(target);
    if (!acquired) return;
    try {
      const existing = await this.readDestroyedArns();
      existing.add(arn);
      await this.atomicWrite(target, JSON.stringify([...existing], null, 2));
    } finally {
      await this.releaseLock(target);
    }
  }

  // --- Rotation ---

  async rotateProvisions(
    maxRecords = 200,
    preserveFilter?: RotationPreserveFilter<ProvisionRecord>,
  ): Promise<number> {
    return rotateRecords({
      store: this,
      target: this.filePath(FileName.PROVISIONS),
      read: () => this.readProvisions(),
      sortByTimestamp: (r) => new Date(r.timestamp).getTime(),
      maxRecords,
      preserveFilter,
      label: "provisions.json",
      suffix: "rotation",
    });
  }

  async rotateFailures(maxRecords = 100): Promise<number> {
    return rotateRecords({
      store: this,
      target: this.filePath(FileName.FAILURES),
      read: () => this.readFailures(),
      maxRecords,
      label: "failures.json",
    });
  }

  async rotatePatterns(maxRecords = 100): Promise<number> {
    return rotateRecords({
      store: this,
      target: this.filePath(FileName.PATTERNS),
      read: () => this.readPatterns(),
      maxRecords,
      label: "patterns.json",
    });
  }
}
