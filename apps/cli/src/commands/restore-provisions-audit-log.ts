/**
 * Wave B-2 (epic-104-demo-dryrun) — `restore-provisions --from-audit-log`.
 *
 * Defense-in-depth fallback restoration path: rebuilds `provisions.json`
 * entries from `apply_resource_created` audit events when the on-disk
 * provision record was lost (e.g. crash mid-apply, or pre-fix double-lock
 * bug). Wave B-1 (PR #22, commit 4eb362c4) landed the audit-event emit;
 * this story consumes those events.
 *
 * Invariants:
 *   - HMAC chain MUST verify before any rebuild work begins. A tampered
 *     log is never trusted to drive a write.
 *   - The append wave acquires `defaultFileAdvisoryLock(PROVISIONS_LOCK_NAME)`
 *     so it is serialised against in-flight applies on the same workstation.
 *   - Idempotent: ARNs already present in `provisions.json` are NEVER
 *     duplicated; re-running the command on the same audit log produces no
 *     additional records.
 *   - Audit entries missing required reconstruction fields are SKIPPED with
 *     a structured stderr warning; they are never silently dropped.
 *   - A safety copy of the current `provisions.json` is written to
 *     `<memoryDir>/provisions.json.pre-restore.<ts>` before any append, so
 *     operators can roll back.
 *
 * @see _bmad-output/implementation-artifacts/feature-restore-provisions-from-audit-log.md
 * @see packages/core/src/utils/memory-recorder.ts (ApplyResourceCreatedEvent)
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import {
  readAuditLog,
  verifyAuditLog,
  DEFAULT_AUDIT_LOG_FILE,
  type AuditLogLine,
  type AuditEntry,
} from "@assignee/core/audit";
import { defaultFileAdvisoryLock } from "@assignee/core/locks";
import {
  log,
  LOG_ACTIONS,
  ProvisionLogSchema,
  ProvisionRecordSchema,
  type ProvisionRecord,
} from "@assignee/core";

// ── Constants ─────────────────────────────────────────────────────────

const DEFAULT_MEMORY_DIR = path.join(os.homedir(), ".assignee", "memory");
const PROVISIONS_FILE = "provisions.json";

/**
 * Lock name = absolute path to the live ledger. Mirrors the constant used
 * inside `packages/core/src/utils/memory-recorder.ts` so a parallel apply
 * (which acquires the same key) is correctly serialised against the
 * recovery append wave. Exported so tests and external callers can assert
 * the lock-key parity without re-deriving the path.
 */
export const PROVISIONS_LOCK_NAME = path.join(
  os.homedir(),
  ".assignee",
  "memory",
  PROVISIONS_FILE,
);

// ── Types ─────────────────────────────────────────────────────────────

export interface RestoreFromAuditLogOptions {
  /**
   * Override the audit log file path. Defaults to
   * `~/.assignee/audit/audit.log`.
   */
  logFile?: string;
  /**
   * Override the memory directory. Defaults to `~/.assignee/memory/`.
   */
  memoryDir?: string;
  /**
   * Override the lock name (defaults to `<memoryDir>/provisions.json`).
   * Used by tests to point the lock at the temp ledger so concurrent
   * parallel-test runs do not collide on the user's real lock file.
   */
  lockName?: string;
  /**
   * HMAC key override. Defaults to whatever
   * `verifyAuditLog` resolves from env / file.
   */
  auditKey?: string;
}

export interface AuditRebuildSkip {
  reason:
    | "missing-required-field"
    | "invalid-record-shape"
    | "schema-validation-failed"
    | "non-target-action";
  /** Audit entry index (chain position). */
  index?: number;
  /** Field name that was missing or invalid (when applicable). */
  field?: string;
  /**
   * Optional ARN of the audit event whose record was skipped — surfaced
   * to operators triaging "which resource didn't recover?" without
   * forcing them to cross-reference index numbers.
   */
  resourceArn?: string;
  /**
   * For `schema-validation-failed`: the ZodIssue.message string(s) from
   * the failed safeParse call. Concatenated with `; ` so the full reason
   * fits in a single log line.
   */
  zodErrors?: string;
}

export interface RestoreFromAuditLogResult {
  ok: boolean;
  /** Records appended to provisions.json during this run. */
  rebuiltCount: number;
  /**
   * Audit entries that matched `apply_resource_created` but were skipped
   * (missing required fields, invalid shape, schema-validation failure,
   * etc.). Excludes already-present ARNs (those are counted under
   * `alreadyPresentCount`) AND in-batch duplicates (`inBatchDuplicateCount`).
   */
  skippedCount: number;
  /**
   * ARNs already present on disk in provisions.json BEFORE the run
   * started. Distinct from `inBatchDuplicateCount` so operators can
   * tell "the record was on disk" from "the audit log emitted the same
   * ARN twice" — both are no-ops for the rebuild but have different
   * causes.
   */
  alreadyPresentCount: number;
  /**
   * In-batch duplicates: audit entries within THIS run that emit an
   * ARN we already saw earlier in the same loop iteration. Distinct
   * from `alreadyPresentCount` (which counts on-disk presence only).
   * Common cause: a resource was apply'd, the audit event landed, but
   * a retry / re-apply emitted a second event for the same ARN.
   */
  inBatchDuplicateCount: number;
  /** Total `apply_resource_created` events seen. */
  candidateCount: number;
  /** Wall-clock duration in ms (for SaaS automation parity). */
  durationMs: number;
  /** Path to the safety backup of provisions.json (null if none was created). */
  safetyBackupPath: string | null;
  /** Path to the live provisions.json. */
  targetPath: string;
  /** Path to the audit log file consulted. */
  logFile: string;
  /** Per-skip reasons (structured, machine-parseable). */
  skips: AuditRebuildSkip[];
  /** Human-readable status message — same contract as `restoreProvisions`. */
  message: string;
  /**
   * On a non-OK outcome: a stable error code consumers can branch on.
   * `AUDIT_LOG_NOT_FOUND`     — log file does not exist.
   * `AUDIT_LOG_TAMPERED`      — chain verification failed (do NOT proceed).
   * `AUDIT_LOG_READ_ERROR`    — IO error while reading the log.
   * `PROVISIONS_JSON_CORRUPT` — current provisions.json is not valid JSON
   *                              or does not parse as an array. Refuse
   *                              to overwrite (operator must inspect).
   */
  errorCode?:
    | "AUDIT_LOG_NOT_FOUND"
    | "AUDIT_LOG_TAMPERED"
    | "AUDIT_LOG_READ_ERROR"
    | "PROVISIONS_JSON_CORRUPT";
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Atomic write: temp file + rename + 0o600 chmod. */
async function atomicWrite(destPath: string, content: string): Promise<void> {
  const tmpSuffix = randomBytes(8).toString("hex");
  const tmpPath = `${destPath}.tmp.${tmpSuffix}`;
  await fs.writeFile(tmpPath, content, { mode: 0o600 });
  await fs.rename(tmpPath, destPath);
  try {
    await fs.chmod(destPath, 0o600);
  } catch {
    // Best-effort on non-POSIX.
  }
}

/**
 * Required fields on an `apply_resource_created` audit event.  Drives the
 * skip-and-warn path: any event missing one of these is recorded as a
 * structured skip so operators can audit the loss.
 */
const REQUIRED_AUDIT_FIELDS = [
  "runId",
  "resourceType",
  "resourceArn",
  "region",
  "estimatedMonthlyCost",
  "desiredStateHash",
  "timestamp",
] as const;

interface ApplyResourceCreatedShape {
  action: string;
  runId: string;
  resourceType: string;
  resourceArn: string;
  region: string;
  estimatedMonthlyCost: string;
  desiredStateHash: string;
  timestamp: string;
}

/**
 * Validate that the audit-entry record is an `apply_resource_created`
 * event with all required fields. Returns the typed payload on success,
 * or `{ skip }` describing the reason on failure.
 */
function tryDecodeApplyResourceCreated(
  entry: AuditEntry,
):
  | { ok: true; record: ApplyResourceCreatedShape }
  | { ok: false; skip: AuditRebuildSkip } {
  const rec = entry.record;
  if (rec === null || typeof rec !== "object") {
    return {
      ok: false,
      skip: { reason: "invalid-record-shape", index: entry.index },
    };
  }
  const obj = rec as Record<string, unknown>;
  if (obj["action"] !== "apply_resource_created") {
    return {
      ok: false,
      skip: { reason: "non-target-action", index: entry.index },
    };
  }
  for (const field of REQUIRED_AUDIT_FIELDS) {
    const value = obj[field];
    if (typeof value !== "string" || value.length === 0) {
      return {
        ok: false,
        skip: {
          reason: "missing-required-field",
          index: entry.index,
          field,
        },
      };
    }
  }
  return {
    ok: true,
    record: {
      action: obj["action"] as string,
      runId: obj["runId"] as string,
      resourceType: obj["resourceType"] as string,
      resourceArn: obj["resourceArn"] as string,
      region: obj["region"] as string,
      estimatedMonthlyCost: obj["estimatedMonthlyCost"] as string,
      desiredStateHash: obj["desiredStateHash"] as string,
      timestamp: obj["timestamp"] as string,
    },
  };
}

/**
 * Reconstruct a ProvisionRecord from a validated audit event. The shape
 * MUST match what `memory-recorder.ts` would have written — Wave B-1 emits
 * the same field values to the audit envelope precisely so reconstruction
 * is byte-equivalent.
 */
function reconstructProvisionRecord(
  payload: ApplyResourceCreatedShape,
): ProvisionRecord {
  return {
    runId: payload.runId,
    resourceType: payload.resourceType,
    resourceArn: payload.resourceArn,
    region: payload.region,
    desiredStateHash: payload.desiredStateHash,
    estimatedMonthlyCost: payload.estimatedMonthlyCost,
    timestamp: payload.timestamp,
  };
}

/**
 * Discriminated-union return type for `loadCurrentProvisions`:
 *   - `{ ok: true, records, arnSet }` — happy path (or salvage path).
 *   - `{ ok: false, errorCode, message }` — corruption: provisions.json
 *     is unparseable JSON. Recovery MUST refuse to overwrite — the
 *     operator must inspect the file before any rebuild touches it.
 *
 * Pre-M1, JSON.parse threw inside the lock callback and the unhandled
 * exception escaped to the action-handler / Commander surface, where
 * users saw a raw stack trace. The structured-failure pattern below
 * matches the existing `restoreProvisions` PR-020 behaviour
 * (`restore-provisions.ts:217-227`).
 */
type LoadCurrentProvisionsResult =
  | { ok: true; records: ProvisionRecord[]; arnSet: Set<string> }
  | {
      ok: false;
      errorCode: "PROVISIONS_JSON_CORRUPT";
      message: string;
    };

/**
 * Read provisions.json from `targetPath` and return `{ records, arnSet }`.
 * On a missing or empty file, returns an empty array. On a JSON.parse
 * failure, returns a structured `PROVISIONS_JSON_CORRUPT` result so the
 * caller can surface a clean failure (not a stack trace) to operators.
 */
async function loadCurrentProvisions(
  targetPath: string,
): Promise<LoadCurrentProvisionsResult> {
  let raw: string;
  try {
    raw = await fs.readFile(targetPath, "utf-8");
  } catch {
    return { ok: true, records: [], arnSet: new Set() };
  }
  if (raw.trim().length === 0) {
    return { ok: true, records: [], arnSet: new Set() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      errorCode: "PROVISIONS_JSON_CORRUPT",
      message:
        `Current provisions.json at "${targetPath}" is not valid JSON ` +
        `(${err instanceof Error ? err.message : String(err)}). Refusing to ` +
        `rebuild on top of a corrupt ledger — inspect the file manually ` +
        `before re-running --from-audit-log.`,
    };
  }
  const fast = ProvisionLogSchema.safeParse(parsed);
  if (fast.success) {
    return {
      ok: true,
      records: fast.data,
      arnSet: new Set(fast.data.map((r) => r.resourceArn)),
    };
  }
  // Per-record salvage: keep valid records, drop invalid ones. Mirrors
  // the salvage strategy in `MemoryService.readProvisions`. Note: a
  // non-array root (e.g. JSON object) lands here too — Array.isArray
  // returns false and we degrade to an empty record set rather than
  // refuse the rebuild, matching the salvage semantics.
  const records: ProvisionRecord[] = [];
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const ok = ProvisionRecordSchema.safeParse(entry);
      if (ok.success) records.push(ok.data);
    }
  }
  return {
    ok: true,
    records,
    arnSet: new Set(records.map((r) => r.resourceArn)),
  };
}

// ── Main entry point ──────────────────────────────────────────────────

/**
 * Walk the audit log, find `apply_resource_created` events whose ARNs are
 * absent from `provisions.json`, and append reconstructed records under
 * the provisions advisory lock.
 *
 * Process steps:
 *   1. Verify the HMAC chain. Abort with `AUDIT_LOG_TAMPERED` on failure.
 *   2. Read all audit entries.
 *   3. Filter to `apply_resource_created` actions.
 *   4. Read current provisions.json into an ARN set.
 *   5. For each candidate event: validate fields, dedupe against the ARN
 *      set, otherwise reconstruct a ProvisionRecord.
 *   6. Acquire the provisions advisory lock.
 *   7. Re-read provisions.json under the lock (CAS pattern: two operators
 *      cannot race a write between step 4 and step 6 because the second
 *      operator sees the first's appends).
 *   8. Write the safety backup.
 *   9. Atomically write provisions.json with the new records appended.
 */
export async function restoreFromAuditLog(
  options: RestoreFromAuditLogOptions = {},
): Promise<RestoreFromAuditLogResult> {
  const start = Date.now();
  const memoryDir = options.memoryDir ?? DEFAULT_MEMORY_DIR;
  const logFile = options.logFile ?? DEFAULT_AUDIT_LOG_FILE;
  const targetPath = path.join(memoryDir, PROVISIONS_FILE);
  // Default lock = the live-ledger constant (matches memory-recorder.ts).
  // When a custom `memoryDir` is supplied (tests / SaaS), the lock follows
  // the custom target so concurrent test runs don't contend on the user's
  // real `~/.assignee/memory/provisions.json` lock file.
  const lockName =
    options.lockName ??
    (options.memoryDir === undefined ? PROVISIONS_LOCK_NAME : targetPath);

  const baseResult = {
    rebuiltCount: 0,
    skippedCount: 0,
    alreadyPresentCount: 0,
    inBatchDuplicateCount: 0,
    candidateCount: 0,
    safetyBackupPath: null as string | null,
    targetPath,
    logFile,
    skips: [] as AuditRebuildSkip[],
  };

  // Step 1 — fail fast if audit log is missing (otherwise verifyAuditLog
  // returns ok:true on an empty chain, which would mask configuration
  // errors).
  if (!fsSync.existsSync(logFile)) {
    return {
      ok: false,
      ...baseResult,
      durationMs: Date.now() - start,
      message: `Audit log not found at "${logFile}". Nothing to rebuild from.`,
      errorCode: "AUDIT_LOG_NOT_FOUND",
    };
  }

  // Step 1 — HMAC chain verification. This is the SECURITY GATE: a
  // tampered log must NEVER drive a write to the live ledger.
  const verify = await verifyAuditLog(logFile, options.auditKey);
  if (!verify.ok) {
    return {
      ok: false,
      ...baseResult,
      durationMs: Date.now() - start,
      message:
        `Audit log HMAC chain verification FAILED at index ${verify.brokenAt} ` +
        `(reason: ${verify.reason}). Refusing to rebuild from a tampered log. ` +
        `Run \`assignee admin audit-verify --log-file ${logFile}\` for full diagnostics.`,
      errorCode: "AUDIT_LOG_TAMPERED",
    };
  }

  // Step 2 — read all audit entries.
  let lines: AuditLogLine[];
  try {
    lines = await readAuditLog(logFile);
  } catch (err) {
    return {
      ok: false,
      ...baseResult,
      durationMs: Date.now() - start,
      message:
        `Failed to read audit log at "${logFile}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
      errorCode: "AUDIT_LOG_READ_ERROR",
    };
  }

  // Step 3 + 5 — filter and validate. We accumulate skips so the operator
  // can see exactly why each entry was dropped. Skips are routed through
  // the shared `log()` helper at WARN level so they are persisted to the
  // rotating daily log file (~/.assignee/logs/cli-YYYY-MM-DD.jsonl),
  // mirrored to OTEL when configured, and visible under --verbose. This
  // matches the Wave B-1 audit-emit failure pattern (see
  // `memory-recorder.ts:230-241`) and gives operators a greppable on-disk
  // trail for triage.
  const candidates: ApplyResourceCreatedShape[] = [];
  const skips: AuditRebuildSkip[] = [];
  let candidateCount = 0;
  // Sentinel runId for skip events that have NO recoverable runId in the
  // audit record (e.g. `runId` itself was the missing field). The shared
  // `log()` helper requires a non-empty runId; this sentinel is greppable
  // and never collides with a real UUID.
  const SKIP_RUN_ID_SENTINEL = "restore-audit-log-skip-no-runid";
  for (const line of lines) {
    if ("preLegacy" in line || "malformed" in line) continue;
    const rec = line.record;
    if (
      rec === null ||
      typeof rec !== "object" ||
      (rec as Record<string, unknown>)["action"] !== "apply_resource_created"
    ) {
      continue; // Non-target action (query_executed, bulk-destroy, etc.).
    }
    candidateCount++;
    const decoded = tryDecodeApplyResourceCreated(line);
    if (!decoded.ok) {
      // Surface the ARN of the offending event when the audit record had
      // a non-empty `resourceArn` field, even when ANOTHER required field
      // was missing. Helps operators correlate skips back to specific
      // resources without grovelling through audit indices.
      const offending = rec as Record<string, unknown>;
      const skipArn =
        typeof offending["resourceArn"] === "string" &&
        (offending["resourceArn"] as string).length > 0
          ? (offending["resourceArn"] as string)
          : undefined;
      const skipRunId =
        typeof offending["runId"] === "string" &&
        (offending["runId"] as string).length > 0
          ? (offending["runId"] as string)
          : SKIP_RUN_ID_SENTINEL;
      const skip: AuditRebuildSkip = {
        ...decoded.skip,
        ...(skipArn !== undefined ? { resourceArn: skipArn } : {}),
      };
      skips.push(skip);
      log({
        ts: new Date().toISOString(),
        level: "warn",
        runId: skipRunId,
        action: LOG_ACTIONS.RESTORE_AUDIT_LOG_SKIP,
        extras: {
          source: "restore-provisions-audit-log",
          reason: skip.reason,
          ...(skip.field !== undefined ? { field: skip.field } : {}),
          ...(skip.index !== undefined ? { index: skip.index } : {}),
          ...(skipArn !== undefined ? { eventArn: skipArn } : {}),
        },
      });
      continue;
    }
    candidates.push(decoded.record);
  }

  // Acquire the lock BEFORE re-reading the live ledger so any racing
  // applies finish their writes before we compute the missing-ARN set.
  // Inside the lock we re-read, dedupe, write the safety backup, and
  // atomically rewrite provisions.json.
  type LockOutcome =
    | {
        ok: true;
        rebuiltRecords: ProvisionRecord[];
        alreadyPresentCount: number;
        inBatchDuplicateCount: number;
        zodSkips: AuditRebuildSkip[];
        safetyBackupPath: string | null;
      }
    | { ok: false; errorCode: "PROVISIONS_JSON_CORRUPT"; message: string };

  const lockResult = await defaultFileAdvisoryLock.withLock<LockOutcome>(
    lockName,
    async (): Promise<LockOutcome> => {
      // Step 4 + 7 — re-read under the lock. Surface a structured
      // PROVISIONS_JSON_CORRUPT failure (M1) instead of letting JSON.parse
      // escape as an unhandled exception.
      await fs.mkdir(memoryDir, { recursive: true, mode: 0o700 });
      const loaded = await loadCurrentProvisions(targetPath);
      if (!loaded.ok) {
        return {
          ok: false,
          errorCode: loaded.errorCode,
          message: loaded.message,
        };
      }
      const { records: existing, arnSet } = loaded;

      // Dedupe with separate accounting for on-disk vs. in-batch
      // duplicates (M3): operators can distinguish "the record is
      // already on disk" (alreadyPresent) from "the audit log emitted
      // the same ARN twice" (inBatchDuplicate). M2: every reconstructed
      // record must round-trip through ProvisionRecordSchema.safeParse
      // so a future audit-emit drift never produces an invalid ledger.
      const rebuiltRecords: ProvisionRecord[] = [];
      const zodSkips: AuditRebuildSkip[] = [];
      let alreadyPresent = 0;
      let inBatchDuplicate = 0;
      const seenInBatch = new Set<string>();
      for (const candidate of candidates) {
        if (arnSet.has(candidate.resourceArn)) {
          alreadyPresent++;
          continue;
        }
        if (seenInBatch.has(candidate.resourceArn)) {
          // Multiple audit events for the same ARN within the same log
          // (re-apply scenario): keep only the FIRST so the appended
          // record set has unique ARNs, matching the ledger contract.
          inBatchDuplicate++;
          continue;
        }
        const reconstructed = reconstructProvisionRecord(candidate);
        const validated = ProvisionRecordSchema.safeParse(reconstructed);
        if (!validated.success) {
          // M2: the reconstructed record fails Zod validation. Emit a
          // structured warning + skip. Without this guard a drifted
          // audit-emit (e.g. non-UUID runId, sub-second timestamp) would
          // poison the ledger — defeating the recovery command.
          const issues = validated.error.issues
            .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("; ");
          const skip: AuditRebuildSkip = {
            reason: "schema-validation-failed",
            resourceArn: candidate.resourceArn,
            zodErrors: issues,
          };
          zodSkips.push(skip);
          log({
            ts: new Date().toISOString(),
            level: "warn",
            runId: candidate.runId,
            action: LOG_ACTIONS.RESTORE_AUDIT_LOG_SKIP,
            extras: {
              source: "restore-provisions-audit-log",
              reason: skip.reason,
              eventArn: candidate.resourceArn,
              zodErrors: issues,
            },
          });
          continue;
        }
        seenInBatch.add(candidate.resourceArn);
        rebuiltRecords.push(validated.data);
      }

      // Nothing to do — exit fast without writing the safety backup.
      if (rebuiltRecords.length === 0) {
        return {
          ok: true,
          rebuiltRecords,
          alreadyPresentCount: alreadyPresent,
          inBatchDuplicateCount: inBatchDuplicate,
          zodSkips,
          safetyBackupPath: null,
        };
      }

      // Step 8 — safety backup. Mirrors the existing `--from <date>`
      // path: copy current provisions.json to a timestamped sibling.
      let safetyBackupPath: string | null = null;
      if (fsSync.existsSync(targetPath)) {
        safetyBackupPath = `${targetPath}.pre-restore.${Date.now()}`;
        try {
          await fs.copyFile(targetPath, safetyBackupPath);
          try {
            await fs.chmod(safetyBackupPath, 0o600);
          } catch {
            // Best-effort.
          }
        } catch {
          // If the backup fails we still proceed: the live ledger is
          // the source of truth, and refusing to write would lose the
          // operator's recovery opportunity.
          safetyBackupPath = null;
        }
      }

      // Step 9 — atomic write of merged provisions.
      const merged = [...existing, ...rebuiltRecords];
      await atomicWrite(targetPath, JSON.stringify(merged, null, 2));

      return {
        ok: true,
        rebuiltRecords,
        alreadyPresentCount: alreadyPresent,
        inBatchDuplicateCount: inBatchDuplicate,
        zodSkips,
        safetyBackupPath,
      };
    },
  );

  // M1 — propagate the PROVISIONS_JSON_CORRUPT failure as a structured
  // result. The action handler emits this via the existing JSON-envelope
  // path (no stack trace ever reaches the operator).
  if (!lockResult.ok) {
    return {
      ok: false,
      ...baseResult,
      durationMs: Date.now() - start,
      message: lockResult.message,
      errorCode: lockResult.errorCode,
    };
  }

  // Merge the parse-time skips (missing fields / invalid shape) with the
  // lock-time skips (Zod-validation failures) so the envelope's
  // `skippedCount` covers BOTH sources.
  const allSkips = [...skips, ...lockResult.zodSkips];
  const durationMs = Date.now() - start;
  const rebuiltCount = lockResult.rebuiltRecords.length;
  const messageParts: string[] = [];
  if (rebuiltCount > 0) {
    messageParts.push(
      `Rebuilt ${rebuiltCount} record(s) from ${candidateCount} audit ` +
        `entr${candidateCount === 1 ? "y" : "ies"}.`,
    );
  } else {
    messageParts.push(
      `No missing records to rebuild. ${candidateCount} audit entr` +
        `${candidateCount === 1 ? "y" : "ies"} examined.`,
    );
  }
  if (lockResult.alreadyPresentCount > 0) {
    messageParts.push(
      `${lockResult.alreadyPresentCount} ARN(s) already present in ` +
        `provisions.json (skipped to preserve idempotency).`,
    );
  }
  if (lockResult.inBatchDuplicateCount > 0) {
    messageParts.push(
      `${lockResult.inBatchDuplicateCount} duplicate audit ` +
        `entr${lockResult.inBatchDuplicateCount === 1 ? "y" : "ies"} ` +
        `for the same ARN within the log (kept first occurrence only).`,
    );
  }
  if (allSkips.length > 0) {
    messageParts.push(
      `${allSkips.length} audit entr${allSkips.length === 1 ? "y" : "ies"} ` +
        `skipped (missing fields, invalid shape, or schema-validation failure).`,
    );
  }
  if (lockResult.safetyBackupPath) {
    messageParts.push(
      `Safety backup written to: ${path.basename(lockResult.safetyBackupPath)}.`,
    );
  }

  return {
    ok: true,
    rebuiltCount,
    skippedCount: allSkips.length,
    alreadyPresentCount: lockResult.alreadyPresentCount,
    inBatchDuplicateCount: lockResult.inBatchDuplicateCount,
    candidateCount,
    durationMs,
    safetyBackupPath: lockResult.safetyBackupPath,
    targetPath,
    logFile,
    skips: allSkips,
    message: messageParts.join(" "),
  };
}
