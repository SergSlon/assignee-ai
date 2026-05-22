/**
 * Post-provision security warnings renderer.
 * Called after successful provisioning when CRITICAL or HIGH findings are detected.
 * Non-blocking — purely informational output.
 *
 * @see Story 19.2, AC #2
 */
import type { SecurityFinding } from "../../types/fix-finding.js";

// F7 fix (2026-05-22): use the same severity-label vocabulary as
// `display-findings.ts` so users see consistent words across modes.
// CRITICAL \u2192 CRIT, MEDIUM \u2192 WARN; HIGH and INFO unchanged.
const SEVERITY_LABEL: Record<string, string> = {
  CRITICAL: "CRIT",
  HIGH: "HIGH",
  MEDIUM: "WARN",
  INFO: "INFO",
};

export function renderSecurityWarnings(
  resourceArn: string,
  findings: SecurityFinding[],
): void {
  if (findings.length === 0) return;

  process.stdout.write(`\n\u26A0 Security findings for ${resourceArn}:\n`);
  for (const finding of findings) {
    const icon =
      finding.severity === "CRITICAL" ? "\uD83D\uDD34" : "\uD83D\uDFE1";
    const label = SEVERITY_LABEL[finding.severity] ?? finding.severity;
    process.stdout.write(`  ${icon} [${label}] ${finding.title}\n`);
    if (finding.recommendation) {
      process.stdout.write(`     \u2192 ${finding.recommendation}\n`);
    }
  }
  process.stdout.write("\n");
}
