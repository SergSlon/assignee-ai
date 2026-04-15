/**
 * Human-readable formatter for CleanupReport results.
 *
 * @see Story 33.2
 */

import type { CleanupReport } from "./types.js";

/**
 * Format a CleanupReport as a human-readable table.
 *
 * @param report - The cleanup report with counts
 * @param dryRun - Whether this was a preview run
 */
export function formatCleanupReport(
  report: CleanupReport,
  dryRun: boolean,
): string {
  const header = dryRun
    ? "Preview (dry-run) — no changes made:"
    : "Cleanup complete:";

  const lines = [
    header,
    "",
    "Category        Cleaned   Remaining",
    "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
    `Checkpoints     ${String(report.checkpoints.pruned).padEnd(10)}${report.checkpoints.kept}`,
    `Price cache     ${String(report.cache.removed).padEnd(10)}${report.cache.remaining}`,
    `Provisions      ${String(report.memory.provisions).padEnd(10)}-`,
    `Failures        ${String(report.memory.failures).padEnd(10)}-`,
    `Patterns        ${String(report.memory.patterns).padEnd(10)}-`,
  ];

  return lines.join("\n");
}
