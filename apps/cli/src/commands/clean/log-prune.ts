/**
 * Log retention pruning for `assignee clean --logs`.
 * Wave-6d F4: split from clean.ts.
 */
import {
  pruneOldLogs,
  resolveLogRetentionDays,
  getLogDir,
  type PruneResult,
} from "../../utils/logger.js";

/**
 * Prune old persistent log files under `~/.assignee/logs` (or
 * `ASSIGNEE_LOG_DIR`). Honors `ASSIGNEE_LOG_RETENTION_DAYS` (default 14).
 *
 * In dry-run mode this reports counts without deleting.
 */
export function runLogPrune(
  dryRun: boolean,
): PruneResult & { retentionDays: number; dir: string } {
  const retentionDays = resolveLogRetentionDays();
  const dir = getLogDir();
  const result = pruneOldLogs(dir, retentionDays, new Date(), { dryRun });
  return { ...result, retentionDays, dir };
}
