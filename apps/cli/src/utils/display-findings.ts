/**
 * Findings display helpers for Assignee.ai CLI.
 * Extracted from display.ts — formatFindings, formatFreeTierNote, formatMemoryHints.
 */

import chalk from "chalk";
import { Severity, type BPFinding } from "@assignee/best-practices";
import { FreeTierType, type FreeTierNote } from "./free-tier.js";
import {
  resolveAction,
  countFixable,
  FixCategory,
} from "./fix-command-resolver.js";

/** Max consequence text length in plan box before truncation. */
const MAX_RISK_LEN = 90;

/** Truncate text at word boundary, appending ellipsis if shortened. */
function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  const cutPoint = lastSpace > maxLen * 0.5 ? lastSpace : maxLen;
  return text.slice(0, cutPoint).trimEnd() + "\u2026";
}

/**
 * Formats all findings (blocking + non-blocking) for display in the plan box.
 * Each finding shows a second line with actionable fix hint from FixCommandResolver.
 * Summary line includes fixable count.
 * TTY mode uses chalk coloring. Non-TTY mode uses plain text markers.
 *
 * @see Story 18.10, Story 35.3
 */
export function formatFindings(findings: BPFinding[] | undefined): string {
  const items = findings ?? [];
  const isTTY = process.stdout.isTTY;

  if (items.length === 0) {
    return isTTY
      ? `Findings:        ${chalk.green("All checks passed")}`
      : "Findings:        PASS All checks passed";
  }

  const blocking = items.filter((f) => f.blocking);
  const critical = items.filter(
    (f) => !f.blocking && f.severity === Severity.CRITICAL,
  );
  const high = items.filter((f) => !f.blocking && f.severity === Severity.HIGH);
  const medium = items.filter(
    (f) => !f.blocking && f.severity === Severity.MEDIUM,
  );
  const info = items.filter((f) => !f.blocking && f.severity === Severity.INFO);

  const fixableCount = countFixable(items);

  const severitySummary = [
    blocking.length > 0 ? `${blocking.length} blocking` : null,
    critical.length > 0 ? `${critical.length} critical` : null,
    high.length > 0 ? `${high.length} high` : null,
    medium.length > 0 ? `${medium.length} medium` : null,
    info.length > 0 ? `${info.length} info` : null,
  ]
    .filter(Boolean)
    .join(", ");

  const summary =
    fixableCount > 0
      ? `${severitySummary} (${fixableCount} fixable)`
      : severitySummary;

  if (isTTY) {
    const lines = [
      `Findings:        ${summary}`,
      ...items.flatMap((f) => {
        const action = resolveAction(f);
        const userChoice = f.userExplicitChoice ? " (user choice)" : "";
        const skipped = f.userSkipped ? " (skipped)" : "";
        const suffix = `${userChoice}${skipped}`;

        let severityLine: string;
        if (f.blocking)
          severityLine = chalk.red(`  BLOCK  ${f.title}${suffix}`);
        else if (f.severity === Severity.CRITICAL)
          severityLine = chalk.red.bold(`  CRIT   ${f.title}${suffix}`);
        else if (f.severity === Severity.HIGH)
          severityLine = chalk.red(`  HIGH   ${f.title}${suffix}`);
        else if (f.severity === Severity.MEDIUM)
          severityLine = chalk.yellow(`  WARN   ${f.title}${suffix}`);
        else severityLine = chalk.blue(`  INFO   ${f.title}${suffix}`);

        // Story 43.1: Consequence/risk line (truncated at word boundary)
        const riskText = f.consequence
          ? truncateAtWord(f.consequence, MAX_RISK_LEN)
          : null;
        const riskLine = riskText
          ? chalk.yellow(`         \u26A0 Risk: ${riskText}`)
          : null;

        // Action hint line
        const hintPrefix =
          action.category === FixCategory.AUTO_FIXABLE
            ? "Fix"
            : action.category === FixCategory.WIZARD_FIXABLE
              ? "Fix"
              : action.category === FixCategory.MANUAL
                ? "Manual"
                : "Info";
        const hintLine = chalk.dim(
          `         \u2192 ${hintPrefix}: ${action.hint}`,
        );

        return riskLine
          ? [severityLine, riskLine, hintLine]
          : [severityLine, hintLine];
      }),
    ];
    return lines.join("\n");
  }

  // Non-TTY: plain text without chalk
  const lines = [
    `Findings:        ${summary}`,
    ...items.flatMap((f) => {
      const action = resolveAction(f);
      const userChoice = f.userExplicitChoice ? " (user choice)" : "";
      const skipped = f.userSkipped ? " (skipped)" : "";
      const suffix = `${userChoice}${skipped}`;

      let severityLine: string;
      if (f.blocking) severityLine = `  [BLOCK] ${f.title}${suffix}`;
      else if (f.severity === Severity.CRITICAL)
        severityLine = `  [CRITICAL] ${f.title}${suffix}`;
      else if (f.severity === Severity.HIGH)
        severityLine = `  [HIGH] ${f.title}${suffix}`;
      else if (f.severity === Severity.MEDIUM)
        severityLine = `  [MEDIUM] ${f.title}${suffix}`;
      else severityLine = `  [INFO] ${f.title}${suffix}`;

      // Story 43.1: Consequence/risk line (non-TTY, truncated at word boundary)
      const riskTextNonTTY = f.consequence
        ? truncateAtWord(f.consequence, MAX_RISK_LEN)
        : null;
      const riskLine = riskTextNonTTY
        ? `         ! Risk: ${riskTextNonTTY}`
        : null;

      const hintPrefix =
        action.category === FixCategory.AUTO_FIXABLE ||
        action.category === FixCategory.WIZARD_FIXABLE
          ? "Fix"
          : action.category === FixCategory.MANUAL
            ? "Manual"
            : "Info";
      const hintLine = `         -> ${hintPrefix}: ${action.hint}`;

      return riskLine
        ? [severityLine, riskLine, hintLine]
        : [severityLine, hintLine];
    }),
  ];
  return lines.join("\n");
}

/**
 * Formats a free tier note for display in the plan box.
 * Returns null if no note is present.
 */
export function formatFreeTierNote(
  note: FreeTierNote | undefined,
): string | null {
  if (!note) return null;
  const icon = note.type === FreeTierType.ALWAYS_FREE ? "\u2713" : "\u2139";
  return `Free Tier:       ${icon} ${note.message}`;
}

/**
 * Formats memory hints for display in the plan box (Story 19.3).
 * Separates cost history (provision records) from warnings (failure records).
 * Returns null if no hints are present.
 */
export function formatMemoryHints(hints: string[] | undefined): string | null {
  if (!hints || hints.length === 0) return null;
  const isTTY = process.stdout.isTTY;
  const lines = hints.map((h) => {
    // Failure warnings get a different label from cost history
    const isWarning = h.startsWith("\u26A0");
    const label = isWarning ? "Warning:         " : "Cost History:    ";
    const formatted = isWarning ? h.replace(/^\u26A0\uFE0F?\s*/, "") : h;
    return isTTY
      ? isWarning
        ? chalk.yellow(`${label}${formatted}`)
        : chalk.dim(`${label}${formatted}`)
      : `${label}${formatted}`;
  });
  return lines.join("\n");
}
