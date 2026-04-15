/**
 * Shared options type for `assignee clean` phases.
 * Wave-6d F4: split from clean.ts.
 */
export interface CleanOpts {
  dryRun?: boolean;
  confirm?: boolean;
  yes?: boolean;
  checkpoints?: boolean;
  cache?: boolean;
  memory?: boolean;
  resources?: boolean;
  logs?: boolean;
  baselines?: boolean;
  json?: boolean;
}
