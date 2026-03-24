/**
 * Progress bar renderer for batch drift checks.
 *
 * Outputs to stderr so stdout remains clean for --json mode.
 *
 * @see Story 28.6 — Batch Drift Check with Parallel Fan-out
 */

/**
 * Render a progress bar to stderr.
 * Format: `Checking resources... [████████░░░░] 23/47 (2 drifted)`
 */
export function renderProgressBar(
  completed: number,
  total: number,
  driftedCount: number,
): void {
  if (total === 0) return;

  const barWidth = 20;
  const fraction = completed / total;
  const filled = Math.round(barWidth * fraction);
  const empty = barWidth - filled;
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);

  const line = `\rChecking resources... [${bar}] ${completed}/${total} (${driftedCount} drifted)`;
  process.stderr.write(line);
}

/**
 * Format a progress bar string (for testing without writing to stderr).
 */
export function formatProgressBar(
  completed: number,
  total: number,
  driftedCount: number,
): string {
  if (total === 0) return "";

  const barWidth = 20;
  const fraction = completed / total;
  const filled = Math.round(barWidth * fraction);
  const empty = barWidth - filled;
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);

  return `Checking resources... [${bar}] ${completed}/${total} (${driftedCount} drifted)`;
}
