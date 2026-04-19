export const CLI_SRC: string;
export const FIXTURE: string;

export function scanShims(cliSrcRoot?: string): Promise<string[]>;

export function loadSnapshot(fixturePath?: string): Promise<string[]>;

export function diffShims(
  current: readonly string[],
  snapshot: readonly string[],
): { added: string[]; removed: string[] };
