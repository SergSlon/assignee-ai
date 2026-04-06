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

export type BudgetCheckResult =
  | BudgetCheckBlocked
  | BudgetCheckWarning
  | BudgetCheckOk;

/**
 * Parse the estimatedMonthlyCost string and return a monthly USD amount.
 * Returns undefined if the string is "Free", "N/A", or unparseable.
 *
 * Handles the common formats emitted by pricing strategies:
 *   - "$0.0104/hour" → hourly × 730
 *   - "$7.59/mo" → direct
 *   - "$0.023/GB-month" → direct (approximation, per-GB is usage-based)
 *   - "Free" / "N/A" → undefined
 *   - Prefixed number: "$0.10"  → as monthly
 */
export function parseMonthlyUsd(cost: string | undefined): number | undefined {
  if (!cost) return undefined;
  const trimmed = cost.trim();
  if (
    !trimmed ||
    trimmed === "Free" ||
    trimmed === "N/A" ||
    trimmed.includes("unavailable")
  ) {
    return undefined;
  }

  // Match first "$<number>" in the string
  const match = trimmed.match(/\$([\d]+(?:\.\d+)?)/);
  if (!match) return undefined;
  const amount = parseFloat(match[1]!);
  if (isNaN(amount)) return undefined;

  const lower = trimmed.toLowerCase();
  if (lower.includes("/hour") || lower.includes("/hr")) {
    return amount * 730; // ~730 hours per month
  }
  if (lower.includes("/day")) {
    return amount * 30;
  }
  if (lower.includes("/minute") || lower.includes("/min")) {
    return amount * 43200;
  }
  // /mo, /month, /GB-month, /GB-mo → treat as monthly direct
  return amount;
}

/**
 * Check the plan's estimated cost against the configured budget limit.
 *
 * @param estimatedMonthlyCost - The cost string from the plan
 * @param budget - User/project config budget settings (optional)
 * @returns BudgetCheckResult indicating ok, warning, or blocked
 */
export function checkBudget(
  estimatedMonthlyCost: string | undefined,
  budget: ConfigBudget | undefined,
): BudgetCheckResult {
  if (!budget || budget.monthly_limit_usd === undefined) {
    return { status: "ok" };
  }

  const limit = budget.monthly_limit_usd;
  const estimated = parseMonthlyUsd(estimatedMonthlyCost);

  if (estimated === undefined) {
    // Can't evaluate — don't block free/N/A resources
    return { status: "ok" };
  }

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
