/**
 * --min-savings validation for `assignee infra optimize`.
 * Wave-6d F4: split from optimize.ts.
 */
import type { OptimizeOpts } from "./types.js";

export interface ParsedOptimizeArgs {
  minSavingsUsd: number;
  /**
   * Set when the raw --min-savings value was invalid; caller should
   * surface the error and abort. Preserves original behavior where the
   * command wrote to stderr and returned `{ success: false }`.
   */
  error?: string;
}

export function parseOptimizeArgs(opts: OptimizeOpts): ParsedOptimizeArgs {
  if (opts.minSavings === undefined) return { minSavingsUsd: 0 };
  const parsed = Number(opts.minSavings);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return {
      minSavingsUsd: 0,
      error: `Invalid --min-savings value '${opts.minSavings}': must be a non-negative number`,
    };
  }
  return { minSavingsUsd: parsed };
}
