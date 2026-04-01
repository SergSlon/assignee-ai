import { ZodError } from "zod";
import type { BestPractice } from "./types.js";
export declare class BPSchemaError extends Error {
  readonly filePath: string;
  readonly fieldErrors: string[];
  constructor(filePath: string, zodError: ZodError);
}
export declare function loadBestPractices(baseDir?: string): BestPractice[];
//# sourceMappingURL=loader.d.ts.map
