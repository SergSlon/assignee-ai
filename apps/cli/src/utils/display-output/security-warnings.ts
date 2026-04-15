/**
 * Post-provision security warnings renderer.
 * Called after successful provisioning when CRITICAL or HIGH findings are detected.
 * Non-blocking — purely informational output.
 *
 * @see Story 19.2, AC #2
 */
import type { SecurityFinding } from "../../services/graph-state.js";

export function renderSecurityWarnings(
  resourceArn: string,
  findings: SecurityFinding[],
): void {
  if (findings.length === 0) return;

  process.stdout.write(`\n\u26A0 Security findings for ${resourceArn}:\n`);
  for (const finding of findings) {
    const icon =
      finding.severity === "CRITICAL" ? "\uD83D\uDD34" : "\uD83D\uDFE1";
    process.stdout.write(`  ${icon} [${finding.severity}] ${finding.title}\n`);
    if (finding.recommendation) {
      process.stdout.write(`     \u2192 ${finding.recommendation}\n`);
    }
  }
  process.stdout.write("\n");
}
