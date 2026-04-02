import { parse } from "yaml";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import { bestPracticeSchema } from "./schema.js";
import type { BestPractice } from "./types.js";

/** Directories to skip when walking best-practices service directories. */
export const SKIP_DIRS = new Set(["src", "dist", "node_modules", "__tests__"]);

export class BPSchemaError extends Error {
  public readonly filePath: string;
  public readonly fieldErrors: string[];

  constructor(filePath: string, zodError: ZodError) {
    const fieldErrors = zodError.errors.map(
      (e) => `${e.path.join(".")}: ${e.message}`,
    );
    const message = `Invalid BP schema in ${filePath}:\n  ${fieldErrors.join("\n  ")}`;
    super(message);
    this.name = "BPSchemaError";
    this.filePath = filePath;
    this.fieldErrors = fieldErrors;
  }
}

export function loadBestPractices(baseDir?: string): BestPractice[] {
  const dir = baseDir ?? join(import.meta.dirname, "..");
  const practices: BestPractice[] = [];

  // Walk service directories (s3/, ec2/, lambda/, etc.)
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;

    const entryPath = join(dir, entry);
    if (!statSync(entryPath).isDirectory()) continue;

    for (const file of readdirSync(entryPath)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;

      const filePath = join(entryPath, file);
      const content = readFileSync(filePath, "utf-8");
      const parsed: unknown = parse(content);

      try {
        const validated = bestPracticeSchema.parse(parsed);
        practices.push(validated as BestPractice);
      } catch (err) {
        if (err instanceof ZodError) {
          throw new BPSchemaError(filePath, err);
        }
        throw err;
      }
    }
  }

  return practices;
}
