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
  };
}): Promise<string[]>;
