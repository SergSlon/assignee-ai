/**
 * Drift detail view — renders a field-by-field diff for a single resource.
 * Pure rendering function (no API calls).
 *
 * @see Story 28.3 — Drift Detail View
 */

import chalk from "chalk";
import {
  DriftStatus,
  ChangeType,
  type DriftResult,
  type DriftedField,
} from "@assignee/core";

export interface DriftDetailOptions {
  /** Disable color output for piping/non-TTY. */
  noColor?: boolean;
  /** Show all fields (including matching ones), not just drifted. */
  verbose?: boolean;
  /** ISO timestamp of when the resource was last provisioned. */
  lastProvisioned?: string;
}

/**
 * Color-coded status string.
 */
function statusColor(status: string, noColor: boolean): string {
  if (noColor) return status;
  switch (status) {
    case DriftStatus.IN_SYNC:
      return chalk.green(status);
    case DriftStatus.DRIFTED:
      return chalk.red(status);
    case DriftStatus.DELETED:
      return chalk.gray(status);
    case DriftStatus.ERROR:
      return chalk.yellow(status);
    case DriftStatus.BASELINE_MISSING:
      return chalk.yellow(status);
    default:
      return status;
  }
}

/**
 * Detect provenance from resource tags.
 */
function detectProvenance(
  actualState?: Record<string, unknown>,
): string | undefined {
  if (!actualState) return undefined;

  // Check for CloudFormation tags
  const tags = actualState["Tags"] as
    | Array<{ Key: string; Value: string }>
    | undefined;
  if (!Array.isArray(tags)) return undefined;

  const cfnStack = tags.find((t) => t.Key === "aws:cloudformation:stack-name");
  if (cfnStack) {
    return `CloudFormation (stack: ${cfnStack.Value})`;
  }

  const cfnLogical = tags.find(
    (t) => t.Key === "aws:cloudformation:logical-id",
  );
  if (cfnLogical) {
    return `CloudFormation (logical ID: ${cfnLogical.Value})`;
  }

  return undefined;
}

/**
 * Format a value for display — truncates long objects.
 */
function formatValue(value: unknown): string {
  if (value === undefined) return "(absent)";
  if (value === null) return "(null)";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  const json = JSON.stringify(value, null, 2);
  if (json.length > 200) return json.slice(0, 197) + "...";
  return json;
}

/**
 * Render a single drifted field.
 */
function renderField(field: DriftedField, noColor: boolean): string {
  const lines: string[] = [];

  switch (field.changeType) {
    case ChangeType.MODIFIED: {
      lines.push(`  ${noColor ? field.path : chalk.bold(field.path)}:`);
      const desired = formatValue(field.desiredValue);
      const actual = formatValue(field.actualValue);
      lines.push(
        `    ${noColor ? "-" : chalk.red("-")} ${desired}${noColor ? "" : chalk.gray("  (desired)")}`,
      );
      lines.push(
        `    ${noColor ? "+" : chalk.green("+")} ${actual}${noColor ? "" : chalk.gray("  (actual)")}`,
      );
      break;
    }
    case ChangeType.ADDED_EXTERNALLY: {
      const label = noColor ? field.path : chalk.yellow(field.path);
      lines.push(`  ${label}:`);
      lines.push(`    ${noColor ? "+" : chalk.yellow("+")} (added externally)`);
      const val = formatValue(field.actualValue);
      if (val !== "(absent)") {
        lines.push(`    ${val}`);
      }
      break;
    }
    case ChangeType.REMOVED: {
      const label = noColor ? field.path : chalk.red(field.path);
      lines.push(`  ${label}:`);
      lines.push(
        `    ${noColor ? "-" : chalk.red("-")} ${formatValue(field.desiredValue)}${noColor ? "" : chalk.gray("  (desired)")}`,
      );
      lines.push(`    ${noColor ? "+" : chalk.red("+")} (removed)`);
      break;
    }
  }

  return lines.join("\n");
}

/**
 * Render a drift detail view for a single resource.
 *
 * @param result - The DriftResult from DriftDetectorService
 * @param opts - Rendering options
 * @returns Formatted string ready for terminal output
 */
export function renderDriftDetail(
  result: DriftResult,
  opts: DriftDetailOptions = {},
): string {
  const noColor = opts.noColor ?? false;
  const lines: string[] = [];

  // Resource header
  const header = `${result.resourceType}  ${result.resourceId}`;
  lines.push(noColor ? header : chalk.bold(header));

  // Status line
  const driftCount =
    result.status === DriftStatus.DRIFTED
      ? ` (${result.driftedFields.length} fields changed)`
      : "";
  lines.push(`Status: ${statusColor(result.status, noColor)}${driftCount}`);

  // Last provisioned
  if (opts.lastProvisioned) {
    lines.push(
      `Last provisioned: ${noColor ? opts.lastProvisioned : chalk.gray(opts.lastProvisioned)}`,
    );
  }

  // Checked at
  lines.push(
    `Checked at: ${noColor ? result.checkedAt : chalk.gray(result.checkedAt)}`,
  );

  // Provenance detection
  const provenance = detectProvenance(result.actualState);
  if (provenance) {
    lines.push(
      `Last modified by: ${noColor ? provenance : chalk.gray(provenance)}`,
    );
  }

  // Error message
  if (result.errorMessage) {
    lines.push(
      `Error: ${noColor ? result.errorMessage : chalk.yellow(result.errorMessage)}`,
    );
  }

  // Field diff section
  if (result.driftedFields.length > 0) {
    lines.push("");
    for (const field of result.driftedFields) {
      lines.push(renderField(field, noColor));
      lines.push("");
    }
  }

  // Verbose mode: show matching fields
  if (opts.verbose && result.desiredState && result.actualState) {
    const driftedPaths = new Set(result.driftedFields.map((f) => f.path));
    lines.push("");
    lines.push(noColor ? "Matching fields:" : chalk.gray("Matching fields:"));

    for (const [key, value] of Object.entries(result.desiredState)) {
      if (!driftedPaths.has(key)) {
        const label = noColor ? key : chalk.green(key);
        lines.push(`  ${label}: ${formatValue(value)}`);
      }
    }
  }

  return lines.join("\n");
}
