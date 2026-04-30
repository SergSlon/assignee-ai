import { parse } from "yaml";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import { bestPracticeSchema } from "./schema.js";
import type { BestPractice } from "./types.js";

/** Directories to skip when walking best-practices service directories. */
export const SKIP_DIRS = new Set(["src", "dist", "node_modules", "__tests__"]);

export class BPSchemaError extends Error {
  /** The first offending file path (preserved for single-file callers). */
  public readonly filePath: string;
  /** All field-level error strings across all offending files. */
  public readonly fieldErrors: string[];

  constructor(filePath: string, zodError: ZodError);
  constructor(message: string, filePath: string, fieldErrors: string[]);
  constructor(
    filePathOrMessage: string,
    zodErrorOrFilePath: ZodError | string,
    fieldErrorsArg?: string[],
  ) {
    if (zodErrorOrFilePath instanceof ZodError) {
      // Single-file construction (original signature — preserved for back-compat).
      const filePath = filePathOrMessage;
      const fieldErrors = zodErrorOrFilePath.errors.map(
        (e) => `${e.path.join(".")}: ${e.message}`,
      );
      const message = `Invalid BP schema in ${filePath}:\n  ${fieldErrors.join("\n  ")}`;
      super(message);
      this.name = "BPSchemaError";
      this.filePath = filePath;
      this.fieldErrors = fieldErrors;
    } else {
      // Multi-file / aggregate construction.
      super(filePathOrMessage);
      this.name = "BPSchemaError";
      this.filePath = zodErrorOrFilePath;
      this.fieldErrors = fieldErrorsArg ?? [];
    }
  }
}

/** A per-file schema error collected during load. */
interface FileError {
  filePath: string;
  fieldErrors: string[];
}

export function loadBestPractices(baseDir?: string): BestPractice[] {
  const dir = baseDir ?? join(import.meta.dirname, "..");
  const practices: BestPractice[] = [];

  // Collect all schema errors rather than fail-fast on the first one.
  const schemaErrors: FileError[] = [];
  // Track seen IDs to detect duplicates: id → first file path that used it.
  const seenIds = new Map<string, string>();

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

      let validated: BestPractice;
      try {
        validated = bestPracticeSchema.parse(parsed) as BestPractice;
      } catch (err) {
        if (err instanceof ZodError) {
          schemaErrors.push({
            filePath,
            fieldErrors: err.errors.map(
              (e) => `${e.path.join(".")}: ${e.message}`,
            ),
          });
          continue;
        }
        throw err;
      }

      // Duplicate-ID detection.
      const existingPath = seenIds.get(validated.id);
      if (existingPath !== undefined) {
        schemaErrors.push({
          filePath,
          fieldErrors: [
            `duplicate rule ID "${validated.id}" — first seen in ${existingPath}`,
          ],
        });
        continue;
      }
      seenIds.set(validated.id, filePath);
      practices.push(validated);
    }
  }

  if (schemaErrors.length > 0) {
    const allFieldErrors: string[] = [];
    const sections: string[] = [];
    for (const fe of schemaErrors) {
      sections.push(`  ${fe.filePath}:\n    ${fe.fieldErrors.join("\n    ")}`);
      allFieldErrors.push(...fe.fieldErrors);
    }
    const message = `Invalid BP schema in ${schemaErrors.length} file(s):\n${sections.join("\n")}`;
    throw new BPSchemaError(message, schemaErrors[0]!.filePath, allFieldErrors);
  }

  return practices;
}
