/**
 * Doctor output rendering: text and summary. JSON emission is trivial
 * (`JSON.stringify(report)`) and stays in the command entrypoint. The
 * JSON output shape is load-bearing — external tooling parses it (see
 * docs/troubleshooting.md).
 */

import { ProcessExitCode } from "../../constants/errors.js";
import type { CheckStatus, DoctorReport, DoctorSection } from "./types.js";

/** Glyphs used for terminal output (Unicode like flutter doctor). */
const STATUS_GLYPH: Record<CheckStatus, string> = {
  ok: "✓",
  warn: "!",
  fail: "✗",
};

/**
 * Convert a status to its terminal exit code.
 *   0 — all green
 *   1 — at least one hard failure (`fail`)
 *   2 — only warnings
 * See docs/troubleshooting.md exit-codes table.
 */
export function statusToExit(status: CheckStatus): number {
  if (status === "fail") return ProcessExitCode.GENERIC_ERROR;
  if (status === "warn") return 2;
  return ProcessExitCode.SUCCESS;
}

/** Pretty-print a single section. */
export function renderSection(section: DoctorSection): string {
  const glyph = STATUS_GLYPH[section.status];
  const lines = [`[${glyph}] ${section.name}`];
  for (const sub of section.subs) {
    const subGlyph = STATUS_GLYPH[sub.status];
    const detail = sub.detail ? ` → ${sub.detail}` : "";
    lines.push(`    • ${subGlyph} ${sub.label}${detail}`);
  }
  return lines.join("\n");
}

/** Pretty-print the full report. */
export function renderReport(report: DoctorReport): string {
  const out: string[] = [`Doctor summary (assignee.ai ${report.version}):`];
  for (const section of report.sections) {
    out.push(renderSection(section));
  }
  out.push("");
  out.push(report.summary);
  out.push("");
  return out.join("\n");
}

/** Build the human summary line. */
export function buildSummary(sections: DoctorSection[]): string {
  const fails = sections.filter((s) => s.status === "fail").length;
  const warns = sections.filter((s) => s.status === "warn").length;
  if (fails === 0 && warns === 0) return "No issues found!";
  const parts: string[] = [];
  if (fails > 0) parts.push(`${fails} failure${fails === 1 ? "" : "s"}`);
  if (warns > 0) parts.push(`${warns} warning${warns === 1 ? "" : "s"}`);
  return `! ${parts.join(", ")} found.`;
}
