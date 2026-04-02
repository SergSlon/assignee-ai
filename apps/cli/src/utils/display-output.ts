/**
 * Non-interactive output helpers for Assignee.ai CLI.
 * Extracted from display.ts — renderIntro, renderOutro, renderError, renderApplySuccess,
 * renderCompoundSuccess, renderSecurityWarnings, renderDependencyPlan, renderResourceTable,
 * renderEmptyList, renderStatusSummary, renderEmptyStatus, startSpinner, updateSpinner, stopSpinner.
 */

import * as clack from "@clack/prompts";
import chalk from "chalk";
import boxen from "boxen";
import type {
  ResourceResult,
  ArchitecturePattern,
  ResourceSpec,
} from "@assignee/core";
import { CostEstimate } from "../constants/pricing.js";
import type { BPFinding } from "@assignee/best-practices";
import type { SecurityFinding } from "../services/graph-state.js";
import type { ManagedResource } from "../services/list-resources.js";
import type { StatusData } from "../services/status-aggregator.js";
import { formatFindings } from "./display-findings.js";
import { regionLabel } from "./display-plan.js";

// ── Spinner (AC2) ────────────────────────────────────────────────────────────

let _spinner: ReturnType<typeof clack.spinner> | null = null;

export function startSpinner(label: string): void {
  if (process.stdout.isTTY) {
    _spinner = clack.spinner();
    _spinner.start(label);
  } else {
    process.stdout.write(`${label}...\n`);
  }
}

export function updateSpinner(label: string): void {
  if (_spinner) {
    _spinner.message(label);
  } else if (!process.stdout.isTTY) {
    process.stdout.write(`${label}...\n`);
  }
}

export function stopSpinner(message?: string): void {
  if (_spinner) {
    _spinner.stop(message);
    _spinner = null;
  }
}

process.on("exit", () => {
  if (_spinner) {
    try {
      _spinner.stop();
    } catch {
      /* ignore */
    }
  }
});

// ── Core render functions ─────────────────────────────────────────────────────

export function renderIntro(): void {
  if (process.stdout.isTTY) {
    clack.intro(chalk.cyan.bold("✦ Assignee.ai — AI-Native Cloud Operator"));
  } else {
    process.stdout.write("✦ Assignee.ai — AI-Native Cloud Operator\n");
  }
}

/**
 * Renders an error message to stderr with structured WHAT / WHY / HOW-TO-FIX format.
 *
 * Overloads:
 * 1. renderError(message, hint?) — legacy format (backward-compatible)
 * 2. renderError(message, hint?, context?) — 3-part structured format
 *
 * @see Story 18.3 — Error Message Quality Audit
 */
export function renderError(
  message: string,
  hint?: string,
  context?: { why?: string },
): void {
  stopSpinner();
  if (process.stderr.isTTY) {
    process.stderr.write(chalk.red(`\u2716 Error: ${message}\n`));
    if (context?.why) {
      process.stderr.write(chalk.yellow(`  Why: ${context.why}\n`));
    }
    if (hint) {
      process.stderr.write(chalk.green(`  How to Fix: ${hint}\n`));
    }
  } else {
    process.stderr.write(`[ERROR] ${message}\n`);
    if (context?.why) {
      process.stderr.write(`[CONTEXT] ${context.why}\n`);
    }
    if (hint) {
      process.stderr.write(`[FIX] ${hint}\n`);
    }
  }
}

import type { RenderableState } from "./display.js";

export function renderApplySuccess(state: RenderableState): void {
  stopSpinner();
  if (process.stdout.isTTY) {
    process.stdout.write(chalk.green("✅ Resource created successfully!\n"));
    if (state.resourceArn) {
      process.stdout.write(chalk.green(`   ARN: ${state.resourceArn}\n`));
    }
    process.stdout.write(chalk.dim(`   Run ID: ${state.runId}\n`));
  } else {
    process.stdout.write(
      `SUCCESS\nARN: ${state.resourceArn ?? CostEstimate.NA}\nRun ID: ${state.runId}\n`,
    );
  }
}

/**
 * Renders a success summary after all compound provisioning resources complete.
 */
export function renderCompoundSuccess(
  results: ResourceResult[],
  pattern: ArchitecturePattern,
): void {
  stopSpinner();

  const resultLines = results.map(
    (r, i) =>
      `  ${i + 1}. ${r.resourceType}${r.resourceArn ? ` → ${r.resourceArn}` : ""}`,
  );

  if (process.stdout.isTTY) {
    const lines = [
      chalk.green.bold(`✓ ${pattern.displayName} provisioned successfully`),
      "",
      ...resultLines,
    ];
    process.stdout.write(
      boxen(lines.join("\n"), {
        padding: 1,
        borderColor: "green",
        title: "Compound Provisioning Complete",
        titleAlignment: "left",
      }) + "\n",
    );
  } else {
    const lines = [
      `✓ ${pattern.displayName} provisioned successfully`,
      "",
      ...resultLines,
    ];
    process.stdout.write(
      `=== Compound Provisioning Complete ===\n${lines.join("\n")}\n======================================\n`,
    );
  }
}

// ── Security warnings (Story 19.2) ────────────────────────────────────────────

/**
 * Renders post-provision security warnings to stdout.
 * Called after successful provisioning when CRITICAL or HIGH findings are detected.
 * Non-blocking — purely informational output.
 *
 * @see Story 19.2, AC #2
 */
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
  process.stdout.write("\n"); // trailing newline
}

/**
 * Renders a compound provisioning plan as a dependency-ordered resource list.
 * Called by human_approval node when resourcePattern is set (compound intent).
 * Non-TTY fallback: plain text without ANSI/boxen (CI-safe).
 *
 * @param pattern - The detected architecture pattern
 * @param resourceQueue - Resources in provisioning order (from compound_dispatcher)
 * @param perResourceCosts - Optional map of resourceId → cost string from preflight_guard
 */
export function renderDependencyPlan(
  pattern: ArchitecturePattern,
  resourceQueue: ResourceSpec[],
  perResourceCosts?: Record<string, string>,
  bpFindings?: BPFinding[],
): void {
  stopSpinner();
  const lines: string[] = [
    `Pattern:  ${pattern.displayName}`,
    ``,
    `Will provision ${resourceQueue.length} resource${resourceQueue.length === 1 ? "" : "s"} in order:`,
    ``,
  ];

  resourceQueue.forEach((resource, index) => {
    const cost = perResourceCosts?.[resource.resourceId];
    lines.push(`  [${index + 1}] ${resource.resourceType}`);
    lines.push(`       ${resource.displayName}${cost ? `  (~${cost})` : ""}`);
    if (index < resourceQueue.length - 1) {
      lines.push(`       ↓`);
    }
  });

  // Compute total cost if any per-resource costs are available
  if (perResourceCosts) {
    const knownCosts = resourceQueue
      .map((r) => perResourceCosts[r.resourceId])
      .filter(
        (c): c is string =>
          Boolean(c) && c !== CostEstimate.NA && c !== CostEstimate.FREE,
      );
    if (knownCosts.length > 0) {
      lines.push(``);
      lines.push(`Estimated cost: ${knownCosts.join(" + ")} /month`);
      if (knownCosts.length < resourceQueue.length) {
        lines.push(`  (partial — not all resource costs estimated yet)`);
      }
    }
  }

  // Story 18.10: Unified findings summary for compound plans
  lines.push(``);
  lines.push(formatFindings(bpFindings));

  lines.push(``);
  lines.push(`Region:   ${regionLabel()}`);

  const content = lines.join("\n");

  if (process.stdout.isTTY) {
    process.stdout.write(
      boxen(content, {
        title: "Compound Provisioning Plan",
        titleAlignment: "left",
        borderColor: "cyan",
        padding: 1,
      }) + "\n",
    );
  } else {
    process.stdout.write(
      `=== Compound Provisioning Plan ===\n${content}\n==================================\n`,
    );
  }
}

// ── Resource list display (Story 18.4) ────────────────────────────────────────

/**
 * Renders a table of managed resources.
 * TTY mode: chalk-colored headers with padded columns in a boxen frame.
 * Non-TTY mode: tab-separated values with a header row (no ANSI).
 *
 * @see Story 18.4, AC #2
 */
export function renderResourceTable(resources: ManagedResource[]): void {
  if (process.stdout.isTTY) {
    // Dynamic column widths based on data
    const col = (label: string, values: string[], min: number) =>
      Math.max(min, label.length + 2, ...values.map((v) => v.length + 2));
    const cType = col(
      "Type",
      resources.map((r) => r.resourceType),
      25,
    );
    const cArn = col(
      "ARN",
      resources.map((r) => r.arn),
      40,
    );
    const cRegion = col(
      "Region",
      resources.map((r) => r.region),
      12,
    );
    const cDate = col(
      "Created",
      resources.map((r) =>
        r.createdDate === CostEstimate.NA
          ? CostEstimate.NA
          : r.createdDate.slice(0, 10),
      ),
      10,
    );
    // Shorten ISO dates to YYYY-MM-DD for display
    const fmtDate = (d: string) =>
      d === CostEstimate.NA ? CostEstimate.NA : d.slice(0, 10);
    const header = chalk.bold(
      "Type".padEnd(cType) +
        "ARN".padEnd(cArn) +
        "Region".padEnd(cRegion) +
        "Created".padEnd(cDate) +
        "Est. Cost",
    );
    const rows = resources.map(
      (r) =>
        r.resourceType.padEnd(cType) +
        r.arn.padEnd(cArn) +
        r.region.padEnd(cRegion) +
        fmtDate(r.createdDate).padEnd(cDate) +
        r.estimatedMonthlyCost,
    );
    const lineWidth = cType + cArn + cRegion + cDate + 20;
    const content = [header, chalk.dim("-".repeat(lineWidth)), ...rows].join(
      "\n",
    );

    process.stdout.write(
      boxen(content, {
        title: "Managed Resources",
        titleAlignment: "center",
        borderColor: "cyan",
        padding: 1,
      }) + "\n",
    );
  } else {
    const header = "Type\tARN\tRegion\tCreated\tEst. Cost";
    const rows = resources.map(
      (r) =>
        `${r.resourceType}\t${r.arn}\t${r.region}\t${r.createdDate}\t${r.estimatedMonthlyCost}`,
    );
    process.stdout.write([header, ...rows].join("\n") + "\n");
  }
}

/**
 * Renders the empty-list message with a hint to run `assignee apply`.
 *
 * @see Story 18.4, AC #5
 */
export function renderEmptyList(): void {
  const message =
    "No resources managed by assignee.ai found. Run `assignee apply` to provision your first resource.";
  if (process.stdout.isTTY) {
    process.stdout.write(chalk.yellow(message) + "\n");
  } else {
    process.stdout.write(message + "\n");
  }
}

// ── Status summary display (Story 19.6) ───────────────────────────────────────

/**
 * Renders the infrastructure status summary.
 * TTY mode: chalk-colored boxen frame with grouped data.
 * Non-TTY mode: plain text without ANSI codes.
 *
 * @see Story 19.6, AC #1
 */
export function renderStatusSummary(data: StatusData): void {
  const lines: string[] = [
    `Total Resources: ${data.totalResources}`,
    `Total Est. Monthly Cost: ${data.totalEstimatedMonthlyCost}`,
    "",
    "By Type:",
  ];

  for (const t of data.byType) {
    lines.push(
      `  ${t.type.padEnd(30)} ${String(t.count).padEnd(4)} ${t.estimatedMonthlyCost}`,
    );
  }

  lines.push("");
  lines.push("By Region:");

  for (const r of data.byRegion) {
    lines.push(
      `  ${r.region.padEnd(30)} ${String(r.count).padEnd(4)} ${r.estimatedMonthlyCost}`,
    );
  }

  const content = lines.join("\n");

  if (process.stdout.isTTY) {
    process.stdout.write(
      boxen(content, {
        title: "assignee.ai \u2014 Infrastructure Status",
        titleAlignment: "center",
        borderColor: "cyan",
        padding: 1,
      }) + "\n",
    );
  } else {
    process.stdout.write(
      `=== Infrastructure Status ===\n${content}\n=============================\n`,
    );
  }
}

/**
 * Renders the empty-status message with a hint to run `assignee plan`.
 *
 * @see Story 19.6, AC #4
 */
export function renderEmptyStatus(): void {
  const message =
    "No resources managed by assignee.ai. Run `assignee plan` to get started.";
  if (process.stdout.isTTY) {
    process.stdout.write(chalk.yellow(message) + "\n");
  } else {
    process.stdout.write(message + "\n");
  }
}

export function renderOutro(success: boolean): void {
  if (process.stdout.isTTY) {
    clack.outro(
      success
        ? chalk.green("✅ Operation completed successfully")
        : chalk.red("❌ Operation failed"),
    );
  } else {
    process.stdout.write(
      success ? "Operation completed successfully\n" : "Operation failed\n",
    );
  }
}
