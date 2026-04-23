/**
 * Shared types for the `assignee optimize` phases.
 * Wave-6d F4: split from optimize.ts.
 */
export interface OptimizeOpts {
  region?: string;
  json?: boolean;
  /**
   * Epic 98 e98.W5.N3 (B-07 / D-16): `-o, --output <format>` for
   * surface parity with plan/apply/destroy/reconcile. `--json`
   * shorthand normalises into this value.
   */
  output?: string;
  minSavings?: string;
  color?: boolean;
}
