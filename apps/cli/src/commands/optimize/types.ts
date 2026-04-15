/**
 * Shared types for the `assignee optimize` phases.
 * Wave-6d F4: split from optimize.ts.
 */
export interface OptimizeOpts {
  region?: string;
  json?: boolean;
  reconcile?: boolean;
  minSavings?: string;
  color?: boolean;
}
