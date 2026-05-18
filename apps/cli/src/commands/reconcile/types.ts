/**
 * Shared types for the `assignee infra reconcile` phases.
 * Wave-6d F4: split out of reconcile.ts.
 */

/** Summary counters for the reconcile run. */
export interface ReconcileSummary {
  reconciled: number;
  accepted: number;
  skipped: number;
  errors: number;
}

/** Prompt function interface for dependency injection in tests. */
export type PromptFn = (message: string, choices: string[]) => Promise<string>;

/** Confirm function interface for dependency injection in tests. */
export type ConfirmFn = (message: string) => Promise<boolean>;

export interface ReconcileOpts {
  resource?: string;
  dryRun?: boolean;
  autoReconcile?: boolean;
  yes?: boolean;
}
