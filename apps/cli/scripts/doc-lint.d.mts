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
}): Promise<string[]>;
