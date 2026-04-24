/**
 * Budget panic limit enforcement (FR-09).
 *
 * Parses the estimatedMonthlyCost string from the plan and compares against
 * `budget.monthly_limit_usd` from user config. When exceeded:
 *   - If `warn_only` is false (default): returns a BlockedResult → apply aborted
 *   - If `warn_only` is true: returns a WarningResult → user sees warning, proceeds
 *
 * Cost string format examples: "$0.0104/hour", "$7.59/mo", "$0.023/GB-month", "Free", "N/A"
 */

import type { ConfigBudget } from "@assignee/core";

export interface BudgetCheckBlocked {
  status: "blocked";
  limit: number;
  estimated: number;
  message: string;
}

export interface BudgetCheckWarning {
  status: "warning";
  limit: number;
  estimated: number;
  message: string;
}

export interface BudgetCheckOk {
  status: "ok";
}

/** Unparseable cost string — fail-closed variant. Returned when a budget
 * limit is set but the cost string can't be interpreted. The caller must
 * decide whether to block, prompt, or override. */
export interface BudgetCheckUnparseable {
  status: "unparseable";
  limit: number;
  rawCost: string;
  message: string;
}

export type BudgetCheckResult =
  | BudgetCheckBlocked
  | BudgetCheckWarning
  | BudgetCheckOk
  | BudgetCheckUnparseable;

/** Sentinel returned by parseMonthlyUsd when the cost is explicitly free/N/A. */
export const FREE_OR_NA = Symbol("FREE_OR_NA");
/** Sentinel returned by parseMonthlyUsd when the cost string is unparseable. */
export const UNPARSEABLE = Symbol("UNPARSEABLE");
export type ParseMonthlyResult =
  | number
  | typeof FREE_OR_NA
  | typeof UNPARSEABLE;

/**
 * Parse the estimatedMonthlyCost string into a monthly USD total.
 *
 * Returns one of:
 *   - `number` — total monthly USD (sum of all `$amount` terms, converted per unit)
 *   - `FREE_OR_NA` — explicit "Free" / "N/A" cost (safe to proceed)
 *   - `UNPARSEABLE` — string contains data but couldn't be interpreted (fail-closed)
 *
 * Handles:
 *   - "$0.0104/hour" → hourly × 730
 *   - "$7.59/mo" → direct
 *   - "$0.023/GB-month" → direct (approximation, per-GB is usage-based)
 *   - "$0.023/GB-month + $0.0004/request" → sums all terms
 *   - "$1,200.50/mo" → handles thousands separators
 *   - "Free" / "N/A" / "unavailable" → FREE_OR_NA
 *   - "$0.10" (no unit) → treated as monthly
 *   - "See pricing calculator" or any string without "$" → UNPARSEABLE
 */
export function parseMonthlyUsd(cost: string | undefined): ParseMonthlyResult {
  if (!cost) return FREE_OR_NA;
  const trimmed = cost.trim();
  if (!trimmed) return FREE_OR_NA;

  // Explicit free/N/A sentinels — safe (no cost to limit)
  const lower = trimmed.toLowerCase();
  if (
    lower === "free" ||
    lower === "n/a" ||
    lower === "na" ||
    lower.includes("unavailable") ||
    lower === "$0" ||
    lower === "$0.00"
  ) {
    return FREE_OR_NA;
  }

  // Find ALL "$<number>" occurrences (handles thousands separators like $1,200.50)
  // Pattern: $ followed by digits with optional commas and optional decimal
  const matches = Array.from(trimmed.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g));
  if (matches.length === 0) return UNPARSEABLE;

  // Helper: find the unit multiplier for a single $ amount by looking at
  // the surrounding substring (from this match to the next, or end of string)
  const findMultiplier = (segment: string): number => {
    const s = segment.toLowerCase();
    if (s.includes("/hour") || s.includes("/hr")) return 730;
    if (s.includes("/day")) return 30;
    if (s.includes("/minute") || s.includes("/min")) return 43200;
    // /mo, /month, /gb-month, /gb-mo, or no unit → monthly direct
    return 1;
  };

  let total = 0;
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const rawAmount = match[1]!.replace(/,/g, "");
    const amount = parseFloat(rawAmount);
    if (isNaN(amount)) return UNPARSEABLE;

    // Segment from this match to the next match (or end of string)
    const segmentStart = match.index ?? 0;
    const nextStart = matches[i + 1]?.index ?? trimmed.length;
    const segment = trimmed.slice(segmentStart, nextStart);
    const multiplier = findMultiplier(segment);

    total += amount * multiplier;
  }

  return total;
}

/**
 * Check the plan's estimated cost against the configured budget limit.
 *
 * @param estimatedMonthlyCost - The cost string from the plan
 * @param budget - User/project config budget settings (optional)
 * @returns BudgetCheckResult indicating ok, warning, or blocked
 */
export function checkMonthlyCostBudget(
  estimatedMonthlyCost: string | undefined,
  budget: ConfigBudget | undefined,
): BudgetCheckResult {
  if (!budget || budget.monthly_limit_usd === undefined) {
    return { status: "ok" };
  }

  const limit = budget.monthly_limit_usd;
  const parsed = parseMonthlyUsd(estimatedMonthlyCost);

  // Explicit free/N/A — safe
  if (parsed === FREE_OR_NA) {
    return { status: "ok" };
  }

  // Fail-closed: cost string is present but unparseable. The guard can't
  // verify the limit, so return an "unparseable" result so the caller can
  // decide (default behavior in plan/apply: warn but don't block, since
  // unparseable strings are typically compound/tiered pricing descriptions
  // the user should review manually).
  if (parsed === UNPARSEABLE) {
    const limitFormatted = `$${limit.toFixed(2)}/mo`;
    return {
      status: "unparseable",
      limit,
      rawCost: estimatedMonthlyCost ?? "",
      message:
        `⚠  Cost '${estimatedMonthlyCost}' cannot be parsed — budget limit ${limitFormatted} cannot be verified. ` +
        `Review the cost breakdown manually before proceeding.`,
    };
  }

  const estimated = parsed;
  if (estimated <= limit) {
    return { status: "ok" };
  }

  const formatted = `$${estimated.toFixed(2)}/mo`;
  const limitFormatted = `$${limit.toFixed(2)}/mo`;

  if (budget.warn_only) {
    return {
      status: "warning",
      limit,
      estimated,
      message: `⚠  Estimated cost ${formatted} exceeds budget limit ${limitFormatted}. Proceeding because warn_only is enabled.`,
    };
  }

  return {
    status: "blocked",
    limit,
    estimated,
    message:
      `❌ Estimated cost ${formatted} exceeds budget limit ${limitFormatted}.\n\n` +
      `To proceed, either:\n` +
      `  • Reduce resource size (e.g., smaller instance type)\n` +
      `  • Raise the limit in .assignee/config.yaml under budget.monthly_limit_usd\n` +
      `  • Set budget.warn_only: true to warn instead of block`,
  };
}
