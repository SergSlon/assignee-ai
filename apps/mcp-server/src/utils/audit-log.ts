/**
 * Persistent audit-log writer for the MCP server.
 *
 * Story 50-5 H-3: previously the MCP server emitted only stderr
 * `mcpLog` records — ephemeral, not tamper-resistant, and never
 * correlatable with CloudTrail for a post-incident review. This
 * module adds an append-only JSON-lines file under
 * `${ASSIGNEE_MCP_AUDIT_DIR ?? ~/.assignee/logs}/mcp-audit-YYYY-MM-DD.jsonl`,
 * rotated daily on first write of a new UTC date.
 *
 * The file is created with mode 0o600 (owner rw) and the parent
 * directory with mode 0o700 (owner rwx) — matching the checkpoint-file
 * hardening in Story 50-5 B-1.
 *
 * Integrity caveat (M-2 accepted, not blocked):
 *   This log is local-only and vulnerable to an operator with disk
 *   access tampering retroactively. For tamperproof infrastructure
 *   audit trail, CloudTrail remains authoritative — each record
 *   includes `runId` / `resourceType` / `identifier` so an analyst
 *   can pivot from the JSONL timeline to the corresponding CloudTrail
 *   events. Per the story spec, adding tamperproof storage is
 *   deferred to the SaaS phase (M-3 / out-of-scope).
 *
 * Redaction policy (per feedback_redaction_allowlist_not_denylist):
 *   We do NOT run a denylist regex over the record fields. Instead,
 *   the surface is a strict allowlist — only the enumerated fields
 *   on `AuditRecord` are written, and `errorClass` is deliberately
 *   a short classification string (e.g. "CheckpointError",
 *   "AccessDenied") never the raw error message, since error
 *   messages are the main leakage vector.
 *
 * SEC-008: Consecutive write-failure alarm + rejection gate.
 *   After MAX_AUDIT_CONSECUTIVE_ALARM (3) consecutive appendFile
 *   failures, a CRITICAL structured alarm is emitted. After
 *   MAX_AUDIT_FAILURES (10) failures within AUDIT_FAILURE_WINDOW_MS
 *   (60 000 ms), new apply_plan / destroy_resource invocations are
 *   rejected with AuditWriteFailedError. The rejection is an async
 *   side-effect — it never throws synchronously inside auditLog itself
 *   (which must keep the "never break the handler" contract). Callers
 *   that need to gate tool dispatch must call assertAuditWriteHealthy()
 *   before invoking the tool logic.
 *
 * SEC-034: Rotation filename anchored to record timestamp, not wall-clock.
 *   The current UTC-day key is derived from the ISO timestamp of the
 *   last successfully appended record. The filename only advances when a
 *   record with a new UTC day arrives — clock skew or wall-clock
 *   manipulation does not straddle records across files.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { redactSensitive } from "@assignee/core";
import { mcpLogError } from "./structured-log.js";

// ── SEC-008: Consecutive failure alarm + rejection gate ───────────────────────

/**
 * After this many consecutive appendFile failures, emit a CRITICAL alarm.
 * Exported so tests can read the threshold without re-deriving it.
 */
export const MAX_AUDIT_CONSECUTIVE_ALARM = 3;

/**
 * After this many failures within AUDIT_FAILURE_WINDOW_MS, reject new
 * apply_plan / destroy_resource calls via assertAuditWriteHealthy().
 */
export const MAX_AUDIT_FAILURES = 10;

/** Rolling window for the failure rate gate (milliseconds). */
export const AUDIT_FAILURE_WINDOW_MS = 60_000;

// ── SEC-008: Module-level failure counters ────────────────────────────────────
// These are module-global so they survive across successive auditLog() calls
// within a single long-running MCP server process. Tests reset them via
// _resetAuditEnvForTests().

/** Consecutive appendFile failures since the last successful write. */
let _consecutiveFailures = 0;

/** Timestamps (ms since epoch) of all appendFile failures within the rolling window. */
let _failureTimestamps: number[] = [];

// ── SEC-034: Module-level rotation state ─────────────────────────────────────
// Stores the UTC-day key ("YYYY-MM-DD") of the last successfully written record.
// The log filename is derived from this key rather than from wall-clock time,
// so clock manipulation cannot straddle records across filenames.

/** UTC-day key of the last successfully appended record, or null on first write. */
let _currentDayKey: string | null = null;

/**
 * SEC-008: Thrown by `assertAuditWriteHealthy()` when the audit write failure
 * count within the rolling window has reached MAX_AUDIT_FAILURES. Tool handlers
 * that call assertAuditWriteHealthy() before executing will surface this to
 * the MCP client as a structured error. The "never break the handler" contract
 * applies only to auditLog() itself — the health-check gate is separate.
 */
export class AuditWriteFailedError extends Error {
  constructor() {
    super(
      `Audit log writes have failed ${MAX_AUDIT_FAILURES} or more times within ${AUDIT_FAILURE_WINDOW_MS / 1_000}s. ` +
        "New apply_plan / destroy_resource invocations are blocked until the audit log is healthy again. " +
        "Check disk space and permissions under the audit log directory.",
    );
    this.name = "AuditWriteFailedError";
  }
}

/**
 * SEC-008: Gate function that tool handlers MUST call before executing
 * mutating operations. Throws AuditWriteFailedError when the rolling
 * failure count has reached MAX_AUDIT_FAILURES.
 *
 * This is intentionally synchronous — it does not perform I/O; it only
 * inspects the in-memory failure counters.
 */
export function assertAuditWriteHealthy(): void {
  const now = Date.now();
  // Prune timestamps outside the rolling window
  _failureTimestamps = _failureTimestamps.filter(
    (t) => now - t <= AUDIT_FAILURE_WINDOW_MS,
  );
  if (_failureTimestamps.length >= MAX_AUDIT_FAILURES) {
    throw new AuditWriteFailedError();
  }
}

/**
 * Returns a UTC-day key ("YYYY-MM-DD") from an ISO timestamp string or Date.
 */
function utcDayKey(timestamp: string | Date): string {
  const d = typeof timestamp === "string" ? new Date(timestamp) : timestamp;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Record shape written to the audit log. Stable across tool types so
 * the JSONL file parses uniformly. All fields required; undefined
 * callers should pass an explicit sentinel (e.g. empty string) so the
 * record doesn't contain undefined JSON.
 */
export interface AuditRecord {
  /** Tool name: "apply_plan" | "destroy_resource" (extend as new mutating tools land). */
  tool: string;
  /** Run identifier from the checkpoint / caller (UUID). Empty string when no run id is available (e.g. ad-hoc destroy). */
  runId: string;
  /** AWS CloudFormation resource type (e.g. "AWS::S3::Bucket"). */
  resourceType: string;
  /** The ARN (preferred) or bare identifier of the resource acted on. */
  identifier: string;
  /** Whether the tool invocation succeeded. */
  success: boolean;
  /** Classification of the error (short kebab-case or error class name). Empty string on success. */
  errorClass: string;
}

/** Resolves the audit directory, honouring the ASSIGNEE_MCP_AUDIT_DIR override. */
export function auditLogDir(): string {
  const override = process.env["ASSIGNEE_MCP_AUDIT_DIR"];
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".assignee", "logs");
}

/**
 * Returns the full path of the audit log file for the given day key
 * ("YYYY-MM-DD"). When no key is supplied it falls back to the current
 * UTC date (wall-clock), which is only used when the module-level
 * `_currentDayKey` has not yet been seeded by a successful write.
 *
 * SEC-034: Callers inside `auditLog()` supply the record's own timestamp
 * key rather than computing from wall-clock time — this anchors the
 * filename to the content, making filename + content tamper-evident as a
 * pair. External callers (tests) may still pass a `Date` for legacy
 * compatibility; they receive the wall-clock-derived path.
 */
export function auditLogPath(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return path.join(auditLogDir(), `mcp-audit-${yyyy}-${mm}-${dd}.jsonl`);
}

/** Returns the audit log path for a pre-computed "YYYY-MM-DD" key. */
function auditLogPathForKey(dayKey: string): string {
  return path.join(auditLogDir(), `mcp-audit-${dayKey}.jsonl`);
}

/**
 * Appends a single JSON-lines record to the audit log. All errors are
 * swallowed — audit logging MUST NEVER propagate a failure back into the
 * tool handler, or an attacker could DoS the handler by filling the audit
 * directory's filesystem. The trade-off is documented in the module-level
 * comment: CloudTrail remains the authoritative audit surface.
 *
 * SEC-008: Tracks consecutive and rolling-window failure counts. After
 * MAX_AUDIT_CONSECUTIVE_ALARM (3) consecutive failures, emits a CRITICAL
 * structured alarm. The rolling-window gate is enforced by the separate
 * assertAuditWriteHealthy() function, which tool handlers call before
 * executing mutating operations.
 *
 * SEC-034: The rotation filename is derived from the record's own
 * timestamp, not wall-clock time. `_currentDayKey` is updated only when
 * a record with a new UTC day arrives — so clock manipulation cannot
 * retroactively straddle records across filenames.
 */
export async function auditLog(record: AuditRecord): Promise<void> {
  // SEC-034: stamp the record with a timestamp and compute the day key
  // from THAT timestamp — not from wall-clock time.
  const recordTimestamp = new Date().toISOString();
  const recordDayKey = utcDayKey(recordTimestamp);

  // SEC-034: update the current-day key only when the record's day differs
  // from the last successfully written record.
  const effectiveDayKey = _currentDayKey ?? recordDayKey;

  try {
    const dir = auditLogDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    // SEC-034: use the effective day key (anchored to the first record of
    // the day) rather than wall-clock time.
    const filePath =
      recordDayKey !== effectiveDayKey
        ? auditLogPathForKey(recordDayKey)
        : auditLogPathForKey(effectiveDayKey);

    const entry =
      JSON.stringify({
        timestamp: recordTimestamp,
        ...record,
      }) + "\n";
    // appendFile with explicit mode ensures newly-created log files
    // start at 0o600. Existing files' modes are respected (appendFile
    // doesn't chmod an existing file), so if an operator has manually
    // tightened the mode further we don't widen it.
    await fs.appendFile(filePath, entry, { encoding: "utf-8", mode: 0o600 });

    // Success: reset consecutive failure counter and update day key.
    _consecutiveFailures = 0;
    _currentDayKey = recordDayKey;
  } catch (err) {
    // Best-effort only. See module comment for rationale — we MUST NOT
    // propagate the failure back to the tool handler.

    // SEC-008: track consecutive failures.
    _consecutiveFailures++;
    const now = Date.now();
    _failureTimestamps.push(now);
    // Prune timestamps outside the rolling window.
    _failureTimestamps = _failureTimestamps.filter(
      (t) => now - t <= AUDIT_FAILURE_WINDOW_MS,
    );

    const isCritical = _consecutiveFailures >= MAX_AUDIT_CONSECUTIVE_ALARM;

    mcpLogError(
      "audit-log",
      "append-failed",
      {
        tool: record.tool,
        runId: record.runId,
        errorClass:
          err instanceof Error ? err.constructor.name : "UnknownError",
        ...(isCritical
          ? {
              severity: "CRITICAL",
              reason: "audit-write-blind",
              consecutiveFailures: _consecutiveFailures,
            }
          : {}),
      },
      redactSensitive(err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * @internal Test-only. Resets process env side-effects and module-level
 * state so unit tests can exercise both the default and override branches
 * deterministically.
 */
export function _resetAuditEnvForTests(): void {
  delete process.env["ASSIGNEE_MCP_AUDIT_DIR"];
  // SEC-008: reset failure counters
  _consecutiveFailures = 0;
  _failureTimestamps = [];
  // SEC-034: reset day key
  _currentDayKey = null;
}
