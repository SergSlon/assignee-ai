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
 *
 * Epic 98 e98.W5.N5 (D-15): removed `yes?: boolean` — the `-y,
 * --yes` flag was registered "for CI wrapper compatibility" but the
 * help footer contradictedly said "No --yes flag is needed". Drift
 * is truly read-only (except `--baseline` which writes a local
 * snapshot). Auto-apply belongs on `reconcile --yes`.
 */
export interface DriftOpts {
  resource?: string;
  region?: string;
  status?: string;
  exclude?: string;
  baseline?: boolean;
  json?: boolean;
  /**
   * Epic 98 e98.W5.N3 (B-07 / D-16): `-o, --output <format>` added for
   * surface parity with plan/apply/destroy/reconcile. `--json` is a
   * shorthand normalised into this value by `resolveJsonMode`.
   */
  output?: string;
  outputFile?: string;
  concurrency?: string;
  detailed?: boolean;
}
