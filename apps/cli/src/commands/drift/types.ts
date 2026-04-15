/**
 * Shared DriftOpts type for the `assignee drift` command phases.
 * Wave-6d F4: split out of drift.ts so sibling phase modules share a
 * single source of truth instead of duplicating the inline shape.
 */
export interface DriftOpts {
  resource?: string;
  region?: string;
  status?: string;
  exclude?: string;
  baseline?: boolean;
  json?: boolean;
  output?: string;
  concurrency?: string;
  color?: boolean;
  verbose?: boolean;
  yes?: boolean;
}
