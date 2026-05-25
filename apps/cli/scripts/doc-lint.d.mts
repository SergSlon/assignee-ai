export function countReadmePatternRows(readmeText: string): number | null;

export function extractIntegrationArchitectureCounts(
  docText: string,
): Array<{
  label: string;
  expect:
    | "supportedTypeCount"
    | "patternCount"
    | "strategyCount"
    | "decomposerCount";
  actual: number | null;
}>;

export function runDocLint(input: {
  readmePath: string;
  integrationArchPath: string;
  runtimeCounts: {
    supportedTypeCount: number;
    patternCount: number;
    strategyCount: number;
    decomposerCount: number;
    commandCount?: number;
    graphNodeCount?: number;
  };
  /** Override the repository root used by cross-doc walkers. */
  repoRoot?: string;
  /**
   * List of repo-relative doc paths the cross-doc walker scans for
   * narrative-count drift. Defaults to a curated set of user-facing
   * docs; tests pass `[]` to scope the walker to in-memory fixtures.
   */
  crossDocTargets?: readonly string[];
  /**
   * When true, skip the flat-path CLI invocation check. Used by tests
   * that feed isolated in-memory fixtures that don't need the full scan.
   */
  skipFlatPathCheck?: boolean;
}): Promise<string[]>;

/**
 * Regex matching a bare flat-path CLI invocation lacking a noun-group prefix.
 * Exported for direct use in unit tests.
 */
export const FLAT_PATH_PATTERN: RegExp;

/**
 * Check a single file for flat-path CLI invocations (Story 108-A-07 drift guard).
 *
 * @param absPath - absolute path to the file to scan
 * @param repoRoot - repo root, used for trimming relative paths in error messages
 * @returns array of error strings (empty when no violations found)
 */
export function checkFileForFlatPaths(
  absPath: string,
  repoRoot: string,
): Promise<string[]>;

/**
 * Run the flat-path scan across all user-facing surfaces.
 *
 * @param repoRoot - absolute path to repo root
 * @returns array of error strings (empty when no violations found)
 */
export function runFlatPathCheck(repoRoot: string): Promise<string[]>;
