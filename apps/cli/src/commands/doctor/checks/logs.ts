/**
 * Doctor check — log retention floor policy (P045).
 *
 * Verifies that the ~/.assignee/logs/ (general) and ~/.assignee/audit/
 * (audit) directories satisfy the minimum retention floors enforced by P045:
 *
 *   General logs:  30-day minimum (ASSIGNEE_LOG_RETENTION_DAYS can only extend)
 *   Audit logs:    90-day minimum (ASSIGNEE_AUDIT_RETENTION_DAYS can only extend)
 *
 * The check is read-only: it never deletes or modifies log files.
 *
 * Warn conditions:
 *   - The configured retention is below the floor (env var misconfigured)
 *   - The log directory is missing (logs have never been written OR were deleted)
 *   - An audit log file's mtime is suspiciously recent relative to oldest entry
 *     (possible aggressive rotation below the floor)
 *
 * @see docs/explanation/log-retention.md
 * @see P045 — acquisition-DD finding
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import {
  resolveLogRetentionDays,
  resolveAuditRetentionDays,
  MINIMUM_LOG_RETENTION_DAYS,
  MINIMUM_AUDIT_RETENTION_DAYS,
} from "@assignee/core";
import type { DoctorSection, DoctorSubCheck } from "../types.js";
import { rollup } from "../util.js";

export interface LogsCheckDeps {
  /** Override home dir root for tests. Defaults to `os.homedir()/.assignee`. */
  assigneeDir?: string;
  /** Override current time for tests. Defaults to `new Date()`. */
  now?: Date;
}

/**
 * Scan `dir` for files whose mtime is more recent than `oldestAllowedMtimeMs`.
 * Returns the count of files that appear too recent (potentially under-retained).
 *
 * The heuristic: if ALL log files in a directory have an mtime within the last
 * N days but the directory's creation date (if accessible) suggests it should
 * contain older files, something may have rotated them away early. This is a
 * soft warning — we cannot definitively prove deletion, only flag the absence.
 */
function countFilesOlderThanDays(
  dir: string,
  floorDays: number,
  now: Date,
): { totalFiles: number; oldestFileMtimeDays: number | null } {
  let totalFiles = 0;
  let oldestMtimeMs: number | null = null;

  try {
    const entries = readdirSync(dir);
    for (const name of entries) {
      if (!name.endsWith(".jsonl") && !name.endsWith(".log")) continue;
      try {
        const s = statSync(join(dir, name));
        totalFiles++;
        if (oldestMtimeMs === null || s.mtimeMs < oldestMtimeMs) {
          oldestMtimeMs = s.mtimeMs;
        }
      } catch {
        // Ignore unreadable files.
      }
    }
  } catch {
    // Directory unreadable.
  }

  const oldestFileMtimeDays =
    oldestMtimeMs !== null
      ? Math.floor((now.getTime() - oldestMtimeMs) / (24 * 60 * 60 * 1000))
      : null;

  return { totalFiles, oldestFileMtimeDays };
}

/**
 * Sub-check: validate that the configured general log retention is at or
 * above the 30-day minimum floor.
 */
function checkGeneralRetentionConfig(): DoctorSubCheck {
  const configured = resolveLogRetentionDays();
  if (configured < MINIMUM_LOG_RETENTION_DAYS) {
    // resolveLogRetentionDays() clamps upward, so this branch is defensive.
    return {
      label: "General log retention",
      status: "warn",
      detail:
        `Configured retention (${configured}d) is below the 30-day minimum floor.` +
        ` Set ASSIGNEE_LOG_RETENTION_DAYS ≥ ${MINIMUM_LOG_RETENTION_DAYS} to comply.`,
    };
  }
  return {
    label: "General log retention",
    status: "ok",
    detail: `${configured}d (minimum floor: ${MINIMUM_LOG_RETENTION_DAYS}d)`,
  };
}

/**
 * Sub-check: validate that the configured audit log retention is at or
 * above the 90-day minimum floor (ISO 27001 A.12.4 + GDPR Art 30 ROPA).
 */
function checkAuditRetentionConfig(): DoctorSubCheck {
  const configured = resolveAuditRetentionDays();
  if (configured < MINIMUM_AUDIT_RETENTION_DAYS) {
    // resolveAuditRetentionDays() already emits a stderr error and returns the
    // floor — this is a second-line UI notice so the doctor output also shows it.
    return {
      label: "Audit log retention [HIGH]",
      status: "warn",
      detail:
        `Configured retention (${configured}d) is below the mandatory 90-day compliance` +
        ` floor (ISO 27001 A.12.4 + GDPR Art 30 ROPA).` +
        ` Set ASSIGNEE_AUDIT_RETENTION_DAYS ≥ ${MINIMUM_AUDIT_RETENTION_DAYS} to comply.`,
    };
  }
  return {
    label: "Audit log retention",
    status: "ok",
    detail: `${configured}d (minimum floor: ${MINIMUM_AUDIT_RETENTION_DAYS}d, compliance: ISO 27001 A.12.4 + GDPR Art 30 ROPA)`,
  };
}

/**
 * Sub-check: confirm the general log directory exists and reports on oldest
 * file age relative to the configured floor.
 */
function checkGeneralLogDirectory(
  logsDir: string,
  retentionDays: number,
  now: Date,
): DoctorSubCheck {
  if (!existsSync(logsDir)) {
    return {
      label: "General logs directory",
      status: "warn",
      detail:
        `${logsDir} does not exist — no logs have been written yet, or all logs` +
        ` were deleted (minimum floor: ${retentionDays}d).`,
    };
  }

  const { totalFiles, oldestFileMtimeDays } = countFilesOlderThanDays(
    logsDir,
    retentionDays,
    now,
  );

  if (totalFiles === 0) {
    return {
      label: "General logs directory",
      status: "ok",
      detail: `${logsDir} exists, no log files present`,
    };
  }

  const oldestLabel =
    oldestFileMtimeDays !== null ? `${oldestFileMtimeDays}d` : "unknown";

  // Warn if the oldest mtime is suspiciously young: if the directory has been
  // in use for longer than the floor, we'd expect files at least floor days old.
  // If nothing is that old, it may indicate aggressive rotation.
  const suspiciouslyYoung =
    oldestFileMtimeDays !== null && oldestFileMtimeDays < retentionDays;

  return {
    label: "General logs directory",
    status: suspiciouslyYoung ? "warn" : "ok",
    detail:
      `${totalFiles} file(s), oldest mtime ${oldestLabel}` +
      (suspiciouslyYoung
        ? ` — no files reach the ${retentionDays}d floor; logs may have been rotated below the minimum.`
        : ` (floor: ${retentionDays}d)`),
  };
}

/**
 * Sub-check: confirm the audit log directory exists and that the audit log
 * file has not been rotated below the 90-day floor.
 */
function checkAuditLogDirectory(
  auditDir: string,
  retentionDays: number,
  now: Date,
): DoctorSubCheck {
  if (!existsSync(auditDir)) {
    return {
      label: "Audit logs directory",
      status: "warn",
      detail:
        `${auditDir} does not exist — no audit records have been written yet, or` +
        ` the audit directory was deleted (minimum floor: ${retentionDays}d).`,
    };
  }

  const { totalFiles, oldestFileMtimeDays } = countFilesOlderThanDays(
    auditDir,
    retentionDays,
    now,
  );

  if (totalFiles === 0) {
    return {
      label: "Audit logs directory",
      status: "ok",
      detail: `${auditDir} exists, no audit log files present`,
    };
  }

  const oldestLabel =
    oldestFileMtimeDays !== null ? `${oldestFileMtimeDays}d` : "unknown";
  const suspiciouslyYoung =
    oldestFileMtimeDays !== null && oldestFileMtimeDays < retentionDays;

  return {
    label: "Audit logs directory",
    status: suspiciouslyYoung ? "warn" : "ok",
    detail:
      `${totalFiles} file(s), oldest mtime ${oldestLabel}` +
      (suspiciouslyYoung
        ? ` — no audit files reach the ${retentionDays}d compliance floor; records may have been deleted in violation of policy.`
        : ` (floor: ${retentionDays}d, ISO 27001 A.12.4 + GDPR Art 30 ROPA)`),
  };
}

/**
 * Run the full log-retention doctor section.
 *
 * Section name: "Log retention"
 * Sub-checks:
 *   1. General log retention (configured value vs 30d floor)
 *   2. Audit log retention (configured value vs 90d floor)
 *   3. General logs directory (existence + oldest mtime)
 *   4. Audit logs directory (existence + oldest mtime)
 */
export function checkLogs(deps: LogsCheckDeps = {}): DoctorSection {
  const assigneeDir = deps.assigneeDir ?? join(os.homedir(), ".assignee");
  const now = deps.now ?? new Date();

  const logsDir = join(assigneeDir, "logs");
  const auditDir = join(assigneeDir, "audit");

  const generalRetentionDays = resolveLogRetentionDays();
  const auditRetentionDays = resolveAuditRetentionDays();

  const subs: DoctorSubCheck[] = [
    checkGeneralRetentionConfig(),
    checkAuditRetentionConfig(),
    checkGeneralLogDirectory(logsDir, generalRetentionDays, now),
    checkAuditLogDirectory(auditDir, auditRetentionDays, now),
  ];

  return {
    name: "Log retention",
    status: rollup(subs),
    subs,
  };
}
