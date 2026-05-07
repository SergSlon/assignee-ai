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
import { safeTry } from "../../types/result.js";
import { FileStore } from "./file-store.js";
import { rotateRecords, type RotationPreserveFilter } from "./rotation.js";

/**
 * Tracks which FileName values have already emitted a schema-drop notice
 * in this process lifetime. Ensures the notice fires AT MOST ONCE per
 * file per process, even when the write-back fails (lock contention) and
 * subsequent reads would normally re-trigger the drop path.
 */
const _alreadyWarnedFiles = new Set<string>();

/**
 * Reset the once-per-process warning tracker.
 * FOR TESTING ONLY — do not call in production code.
 * @internal
 */
export function _resetAlreadyWarnedFilesForTesting(): void {
  _alreadyWarnedFiles.clear();
}

/**
 * Returns true when the current CLI invocation is in JSON output mode.
 * Checks `process.argv` for `--json` (boolean shorthand) or
 * `--output json` / `-o json` (explicit enum). Mirrors the argv-based
 * detection used elsewhere in the CLI layer (e.g. logger.ts).
 *
 * The memory service lives in core (no CLI imports allowed), so we inspect
 * argv directly rather than importing resolveJsonMode from apps/cli.
 */
function isJsonMode(): boolean {
  const argv = process.argv;
  if (argv.includes("--json")) return true;
  for (let i = 0; i < argv.length - 1; i++) {
    if (
      (argv[i] === "--output" || argv[i] === "-o") &&
      argv[i + 1] === "json"
    ) {
      return true;
    }
  }
  return false;
}

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

const MEMORY_DIR = path.join(os.homedir(), ASSIGNEE_DIR, "memory");

export class MemoryService extends FileStore {
  constructor(dir: string = MEMORY_DIR) {
    super(dir);
  }

  /**
   * After a filter dropped ≥ 1 stale record, write the cleaned set back
   * to disk so the next read takes the schema fast-path and the warning
   * never repeats. Best-effort: lock-contention or write failures don't
   * propagate — the in-memory filter result is what callers see, and the
   * next run will retry.
   */
  private async rewriteFilteredFile<T>(
    fileName: string,
    validRecords: T[],
  ): Promise<void> {
    const target = this.filePath(fileName);
    const acquired = await this.acquireLock(target);
    if (!acquired) return;
    try {
      await this.atomicWrite(target, JSON.stringify(validRecords, null, 2));
    } catch {
      // Best-effort; subsequent reads will retry.
    } finally {
      await this.releaseLock(target);
    }
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
        if (!_alreadyWarnedFiles.has(FileName.PROVISIONS)) {
          _alreadyWarnedFiles.add(FileName.PROVISIONS);
          if (!isJsonMode()) {
            process.stderr.write(
              `[assignee] Cleaned ${dropped} stale record(s) from ${FileName.PROVISIONS} (schema migration; one-time notice).\n`,
            );
          }
        }
        await this.rewriteFilteredFile(FileName.PROVISIONS, valid);
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

  /**
   * Append a provision record to provisions.json.
   *
   * NOTE: This method is ONLY called from `memory-recorder.ts`
   * (`writeProvisionRecord`), which already holds the outer
   * `defaultFileAdvisoryLock` via `withLock(PROVISIONS_LOCK_NAME, ...)`.
   * Do NOT add an inner `acquireLock` here — that would cause a re-entrant
   * double-lock on the same lock file, causing the inner acquire to see the
   * outer lock as "held by another writer" and silently drop the write.
   * (Bug: "Could not acquire lock for provisions.json — skipping write to
   * prevent corruption" observed in compound applies.)
   */
  async appendProvision(record: ProvisionRecord): Promise<void> {
    await this.ensureDir();
    const target = this.filePath(FileName.PROVISIONS);
    const existing = await this.readProvisions();
    existing.push(record);
    await this.atomicWrite(target, JSON.stringify(existing, null, 2));
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
        if (!_alreadyWarnedFiles.has(FileName.FAILURES)) {
          _alreadyWarnedFiles.add(FileName.FAILURES);
          if (!isJsonMode()) {
            process.stderr.write(
              `[assignee] Cleaned ${dropped} stale record(s) from ${FileName.FAILURES} (schema migration; one-time notice).\n`,
            );
          }
        }
        await this.rewriteFilteredFile(FileName.FAILURES, valid);
      }
      return valid;
    } catch {
      await this.backupCorruptFile(FileName.FAILURES);
      return [];
    }
  }

  /**
   * Append a failure record to failures.json.
   *
   * NOTE: Only called from `memory-recorder.ts` (`writeFailureRecord`), which
   * holds the outer `defaultFileAdvisoryLock`. No inner lock here — same
   * re-entrant double-lock guard as `appendProvision` above.
   */
  async appendFailure(record: FailureRecord): Promise<void> {
    await this.ensureDir();
    const target = this.filePath(FileName.FAILURES);
    const existing = await this.readFailures();
    existing.push(record);
    await this.atomicWrite(target, JSON.stringify(existing, null, 2));
  }

  /**
   * Remove all failure records for a given resource type.
   * Called after a successful provision so stale errors are not surfaced.
   *
   * NOTE: Only called from `memory-recorder.ts` (`clearFailureHistory`),
   * which does NOT hold the outer lock (it calls directly, no `withLock`
   * wrapper). Safe without inner lock because `clearFailureHistory` is a
   * best-effort cleanup — it cannot interleave destructively with the
   * provision/failure writes (different logical operation, same-process,
   * sequential event loop). If concurrent safety is needed in future, route
   * through a `withLock` wrapper in `memory-recorder.ts`.
   */
  async clearFailuresForType(resourceType: string): Promise<void> {
    await this.ensureDir();
    const target = this.filePath(FileName.FAILURES);
    const existing = await this.readFailures();
    const filtered = existing.filter((f) => f.resourceType !== resourceType);
    if (filtered.length === existing.length) return;
    await this.atomicWrite(target, JSON.stringify(filtered, null, 2));
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
        if (!_alreadyWarnedFiles.has(FileName.PATTERNS)) {
          _alreadyWarnedFiles.add(FileName.PATTERNS);
          if (!isJsonMode()) {
            process.stderr.write(
              `[assignee] Cleaned ${dropped} stale record(s) from ${FileName.PATTERNS} (schema migration; one-time notice).\n`,
            );
          }
        }
        await this.rewriteFilteredFile(FileName.PATTERNS, valid);
      }
      return valid;
    } catch {
      await this.backupCorruptFile(FileName.PATTERNS);
      return [];
    }
  }

  /**
   * Upsert a pattern record in patterns.json.
   *
   * NOTE: Only called from `memory-recorder.ts` (`upsertPatternRecord`), which
   * holds the outer `defaultFileAdvisoryLock`. No inner lock here — same
   * re-entrant double-lock guard as `appendProvision` above.
   */
  async upsertPattern(record: PatternRecord): Promise<void> {
    await this.ensureDir();
    const target = this.filePath(FileName.PATTERNS);
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

  /**
   * Append a destroyed ARN to destroyed-arns.json.
   *
   * NOTE: Only called from `memory-recorder.ts` (`appendDestroyedArn`), which
   * does NOT hold the outer lock (direct call, no `withLock` wrapper). Safe
   * for the same reason as `clearFailuresForType` — best-effort, no
   * interleave risk with provision writes in the same process.
   */
  async appendDestroyedArn(arn: string): Promise<void> {
    if (!arn) return;
    await this.ensureDir();
    const target = this.filePath(FileName.DESTROYED_ARNS);
    const existing = await this.readDestroyedArns();
    existing.add(arn);
    await this.atomicWrite(target, JSON.stringify([...existing], null, 2));
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
