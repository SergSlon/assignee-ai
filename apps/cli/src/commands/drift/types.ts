/**
 * Shared DriftOpts type for the `assignee drift` command phases.
 * Wave-6d F4: split out of drift.ts so sibling phase modules share a
 * single source of truth instead of duplicating the inline shape.
 *
 * Epic 92 / story e92-3b2 (D-03/D-04/C-23):
 *   - Removed `color?: boolean` — local `--no-color` was deleted in
 *     favour of the global `--no-color` declared on the root
 *     program; callers source `chalk.level === 0` instead.
 *   - Removed `verbose?: boolean` — local `--verbose` collided with
 *     the global `--verbose` (diagnostic logging). The per-field
 *     detail semantics moved to a new `--detailed` option.
 *   - Renamed `output` → `outputFile` — the `--output <file>` flag
 *     was renamed to `--output-file <file>` so it no longer collides
 *     with other commands' `--output <format>` semantics.
 */
export interface DriftOpts {
  resource?: string;
  region?: string;
  status?: string;
  exclude?: string;
  baseline?: boolean;
  json?: boolean;
  outputFile?: string;
  concurrency?: string;
  detailed?: boolean;
  yes?: boolean;
}
