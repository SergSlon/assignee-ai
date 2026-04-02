/**
 * Plan rendering helpers for Assignee.ai CLI.
 * Extracted from display.ts — renderPlanBox, formatCostLine, formatPricingBreakdown,
 * formatAppliedFixes, formatFixValue, formatAutoFixHint, regionLabel.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import boxen from "boxen";
import {
  AWS_REGION,
  BEDROCK_MODEL_ID,
  BoxenAlign,
  BoxenBorderColor,
} from "../config/constants.js";
import type { AppliedFix } from "../services/graph-state.js";
import { CostEstimateLabel, type PricingBreakdown } from "@assignee/core";
import { countAutoFixable } from "./fix-command-resolver.js";
import { formatDesiredState } from "./display.js";
import type { RenderableState } from "./display.js";
// NOTE: display.ts re-exports from this module, creating a circular reference.
// This is safe because: (1) RenderableState is type-only (erased at runtime),
// (2) formatDesiredState is defined directly in display.ts (not re-exported from
// another sub-module), so it is available by the time any function here executes.
import {
  formatFindings,
  formatFreeTierNote,
  formatMemoryHints,
} from "./display-findings.js";
import { stopSpinner } from "./display-output.js";

/** Returns the region label for the plan box.
 *  Cross-regional inference profiles (us.*, eu.*, ap.*) are annotated. */
export function regionLabel(): string {
  const crossRegionalPrefix = BEDROCK_MODEL_ID.match(/^(us|eu|ap)\./)?.[1];
  return crossRegionalPrefix
    ? `${AWS_REGION} (cross-regional inference: ${crossRegionalPrefix}.*)`
    : AWS_REGION;
}

/**
 * Formats the estimated cost display. When a pricing breakdown is available
 * (from decomposer), it is rendered separately. This function just returns
 * the base estimate label from Pricing MCP (no hardcoded rates).
 *
 * @see Story 23.5 — zero hardcoded dollar amounts
 */
export function formatCostLine(
  estimatedMonthlyCost: string | undefined,
): string {
  return estimatedMonthlyCost ?? CostEstimateLabel.NA;
}

export function renderPlanBox(state: RenderableState): void {
  stopSpinner();

  // Story 22.3: Auto-fixed best practice findings
  const appliedFixesLine = formatAppliedFixes(state.appliedFixes);

  // Story 18.10: Unified findings section (merged guardrails + best practices)
  const findingsLine = formatFindings(state.bpFindings);

  // Story 7.8: Free tier note line (optional, non-blocking)
  const freeTierLine = formatFreeTierNote(state.freeTierNote);

  // Story 19.3: Memory hints from provision history (optional)
  const memoryHintLines = formatMemoryHints(state.memoryHints);

  const configBlock = state.desiredState
    ? formatDesiredState(state.desiredState)
    : "(none)";

  // Story 23.5: Cost from Pricing MCP (no hardcoded rates)
  const costLine = formatCostLine(state.estimatedMonthlyCost);

  // Story 23.6: Pricing breakdown from decomposers (if available)
  const breakdownLines = state.pricingBreakdown
    ? formatPricingBreakdown(state.pricingBreakdown)
    : null;

  const autoFixHintLine = formatAutoFixHint(state);

  // Story 37.1: source files line
  let sourceFilesLine: string | null = null;
  if (state.sourceDir) {
    const fileCount =
      state.sourceFileCount ?? countFilesRecursive(state.sourceDir);
    sourceFilesLine = `Source files:    ${fileCount} file${fileCount === 1 ? "" : "s"} from ${state.sourceDir}`;
  }

  const content = [
    `Resource Type:   ${state.resourceType}`,
    `Region:          ${regionLabel()}`,
    `Config:`,
    configBlock,
    `Estimated Cost:  ${costLine}`,
    ...(sourceFilesLine ? [sourceFilesLine] : []),
    ...(breakdownLines ? [breakdownLines] : []),
    ...(freeTierLine ? [freeTierLine] : []),
    ...(memoryHintLines ? [memoryHintLines] : []),
    ...(appliedFixesLine ? [appliedFixesLine] : []),
    findingsLine,
    ...(autoFixHintLine ? [autoFixHintLine] : []),
    ...(state.verbose || process.argv.includes("--verbose")
      ? [`Run ID:          ${state.runId}`]
      : []),
  ].join("\n");

  if (process.stdout.isTTY) {
    process.stdout.write(
      boxen(content, {
        title: "Plan",
        titleAlignment: BoxenAlign.CENTER,
        borderColor: BoxenBorderColor.CYAN,
        padding: 1,
      }) + "\n",
    );
  } else {
    process.stdout.write(`=== Plan ===\n${content}\n============\n`);
  }
}

/**
 * Formats the pricing breakdown for display in the plan box.
 * Shows fixed costs as a table, subtotal, and usage-based per-unit rates.
 *
 * @see Story 23.6
 */
export function formatPricingBreakdown(breakdown: PricingBreakdown): string {
  const lines: string[] = [];
  const isTTY = process.stdout.isTTY;

  if (breakdown.fixedItems.length > 0) {
    // Calculate max label width for alignment
    const maxLabel = Math.max(
      ...breakdown.fixedItems.map((item) => item.lineItem.label.length),
    );

    for (const item of breakdown.fixedItems) {
      const label = item.lineItem.label.padEnd(maxLabel);
      const desc = item.lineItem.description.padEnd(20);
      const price = item.displayPrice;
      lines.push(`  ${label}   ${desc} ${price}`);
    }

    // Separator + subtotal
    lines.push(`  ${"─".repeat(maxLabel + 25)}`);
    const subtotal =
      breakdown.fixedSubtotal > 0
        ? `$${breakdown.fixedSubtotal.toFixed(2)}/mo`
        : CostEstimateLabel.NA;
    lines.push(`  ${"Subtotal (fixed)".padEnd(maxLabel + 20)} ${subtotal}`);
  }

  if (breakdown.usageBasedItems.length > 0) {
    lines.push(``);
    lines.push(`  Usage-based (per-unit rates):`);
    for (const item of breakdown.usageBasedItems) {
      const price = item.displayPrice;
      lines.push(`  · ${item.lineItem.label.padEnd(24)} ${price}`);
    }
  }

  // Fetched timestamp
  const fetchedNote = isTTY
    ? chalk.dim(`  Prices fetched at ${breakdown.fetchedAt}`)
    : `  Prices fetched at ${breakdown.fetchedAt}`;
  lines.push(fetchedNote);

  if (breakdown.hasPartialFailure) {
    const warning = isTTY
      ? chalk.yellow(`  ⚠ Some prices unavailable`)
      : `  ⚠ Some prices unavailable`;
    lines.push(warning);
  }

  return lines.join("\n");
}

/**
 * Formats auto-fixed best practice items for display in the plan box.
 * Returns null if no fixes were applied.
 *
 * @see Story 22.3
 */
export function formatAppliedFixes(
  fixes: AppliedFix[] | undefined,
): string | null {
  if (!fixes || fixes.length === 0) return null;
  const isTTY = process.stdout.isTTY;

  const header = `Auto-fixed:      ${fixes.length} fix${fixes.length === 1 ? "" : "es"} applied`;
  const lines = fixes.map((f) => {
    const detail = `  \u2713 ${f.title} (${f.fieldPath}: ${formatFixValue(f.oldValue)} \u2192 ${formatFixValue(f.newValue)})`;
    return isTTY ? chalk.green(detail) : detail;
  });

  return [header, ...lines].join("\n");
}

export function formatFixValue(value: unknown): string {
  if (value === undefined || value === null) return "unset";
  if (typeof value === "boolean") return value ? "enabled" : "disabled";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Story 35.6: Show hint when auto-fix is disabled but auto-fixable findings exist.
 * Returns null when auto-fix is enabled or no auto-fixable findings remain.
 */
export function formatAutoFixHint(state: RenderableState): string | null {
  if (state.autoFixEnabled) return null;
  const items = state.bpFindings ?? [];
  if (items.length === 0) return null;

  const autoFixCount = countAutoFixable(items);
  if (autoFixCount === 0) return null;

  const isTTY = process.stdout.isTTY;
  const msg = `${autoFixCount} finding${autoFixCount === 1 ? "" : "s"} can be auto-fixed. Run \`assignee init\` to enable.`;
  return isTTY ? chalk.cyan(`  \u{1F4A1} ${msg}`) : `  * ${msg}`;
}

/**
 * Story 37.1: Recursively count files in a directory.
 * Used by renderPlanBox to display the source file count.
 */
function countFilesRecursive(dir: string, maxDepth = 20): number {
  if (maxDepth <= 0) return 0;
  try {
    let count = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        count += countFilesRecursive(path.join(dir, entry.name), maxDepth - 1);
      } else {
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}
