/**
 * Guard 2 (CP-4 / PH1-D-2) — Doc-↔-code parity test.
 *
 * For each pattern file's leading JSDoc block, extracts named AWS managed-
 * policy / role / IAM entities via regex on the pattern:
 *   /AWSLambdaBasicExecutionRole|AWSLambda\w+Role|PowerUserAccess|AWSManaged\w+/g
 *
 * Asserts each entity found in the doc also appears in that file's source
 * code OUTSIDE the JSDoc block (i.e., the entity is implemented, not just
 * promised). Fails with:
 *   pattern <name>: doc mentions "<entity>" but it does not appear in
 *   the file body (outside the JSDoc block).
 *
 * This guards against the CP-4 root cause: the lambda-with-exec-role.ts
 * doc claimed "AWSLambdaBasicExecutionRole policy attached" but the code
 * did not attach it. The guard would have caught the lie on commit.
 *
 * Implementation note: we read source files via fs.readFileSync so the
 * guard operates on the actual TypeScript source, not compiled JS.
 * Pattern source files are co-located at ./patterns/<name>.ts relative
 * to this __tests__ directory.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATTERNS_DIR = path.resolve(__dirname, "../patterns");

/** AWS IAM entity names that, when mentioned in a JSDoc, must appear in code. */
const IAM_ENTITY_REGEX =
  /AWSLambdaBasicExecutionRole|AWSLambda\w+Role|PowerUserAccess|AWSManaged\w+/g;

/**
 * Constant aliases: an IAM entity named in a JSDoc may be referenced in
 * code via a symbolic constant name instead of a string literal. Map each
 * IAM entity to its known constant aliases so the parity check accepts both
 * the literal string and any canonical alias as evidence of implementation.
 */
const ENTITY_CODE_ALIASES: Record<string, string[]> = {
  AWSLambdaBasicExecutionRole: [
    "LAMBDA_BASIC_EXECUTION_PATH",
    "LAMBDA_BASIC_EXECUTION",
  ],
  PowerUserAccess: ["POWER_USER_ACCESS_PATH", "POWER_USER_ACCESS"],
};

/**
 * Extract the leading JSDoc block from a source file (the first `/** ... * /`
 * block starting from the beginning of the file). Returns null if not found.
 */
function extractLeadingJsDoc(source: string): string | null {
  // Match a block comment at the very start (possibly after whitespace).
  const match = source.match(/^[\s]*\/\*\*([\s\S]*?)\*\//);
  return match ? match[0] : null;
}

/**
 * Return all unique IAM entity names mentioned in the given text block.
 */
function extractIamEntities(block: string): string[] {
  const matches = block.match(IAM_ENTITY_REGEX) ?? [];
  return [...new Set(matches)];
}

/**
 * Return all pattern source files in the patterns directory.
 */
function getPatternSourceFiles(): string[] {
  return fs
    .readdirSync(PATTERNS_DIR)
    .filter(
      (f) =>
        f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"),
    )
    .map((f) => path.join(PATTERNS_DIR, f));
}

describe("Guard 2 — pattern doc-↔-code parity (CP-4)", () => {
  const patternFiles = getPatternSourceFiles();

  it("found at least 4 pattern source files to check", () => {
    expect(patternFiles.length).toBeGreaterThanOrEqual(4);
  });

  it("every IAM entity mentioned in a pattern JSDoc block appears in the file body", () => {
    const failures: string[] = [];

    for (const filePath of patternFiles) {
      const patternName = path.basename(filePath, ".ts");
      const source = fs.readFileSync(filePath, "utf-8");

      const jsDoc = extractLeadingJsDoc(source);
      if (!jsDoc) continue;

      const mentionedEntities = extractIamEntities(jsDoc);
      if (mentionedEntities.length === 0) continue;

      // The "file body" is the source AFTER the leading JSDoc block.
      const bodyStart = source.indexOf(jsDoc) + jsDoc.length;
      const fileBody = source.slice(bodyStart);

      for (const entity of mentionedEntities) {
        const aliases = ENTITY_CODE_ALIASES[entity] ?? [];
        const entityOrAliasPresent =
          fileBody.includes(entity) ||
          aliases.some((alias) => fileBody.includes(alias));
        if (!entityOrAliasPresent) {
          failures.push(
            `pattern ${patternName}: doc mentions "${entity}" but neither the literal ` +
              `string nor any known alias (${aliases.join(", ") || "none"}) appears ` +
              `in the file body (outside the JSDoc block). ` +
              `Either add the implementation or remove the doc claim.`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("lambda-with-exec-role.ts: doc mentions AWSLambdaBasicExecutionRole and it is present in code (Variation F)", () => {
    const lambdaFilePath = path.join(PATTERNS_DIR, "lambda-with-exec-role.ts");
    const source = fs.readFileSync(lambdaFilePath, "utf-8");

    // Variation F: verify the doc comment at lines 11-13 no longer falsely
    // claims attachment when the code does not implement it.
    const jsDoc = extractLeadingJsDoc(source);
    expect(jsDoc).not.toBeNull();

    const entities = extractIamEntities(jsDoc!);
    expect(entities).toContain("AWSLambdaBasicExecutionRole");

    // The entity must appear in the file body (outside the doc block).
    // The code uses the constant LAMBDA_BASIC_EXECUTION_PATH rather than
    // the literal string, which is the correct pattern per aws-arns.ts.
    const bodyStart = source.indexOf(jsDoc!) + jsDoc!.length;
    const fileBody = source.slice(bodyStart);
    // Accept either the literal name OR the canonical constant alias
    const hasLiteralOrAlias =
      fileBody.includes("AWSLambdaBasicExecutionRole") ||
      fileBody.includes("LAMBDA_BASIC_EXECUTION_PATH");
    expect(
      hasLiteralOrAlias,
      "Expected file body to contain 'AWSLambdaBasicExecutionRole' or its constant alias 'LAMBDA_BASIC_EXECUTION_PATH'",
    ).toBe(true);
  });

  it("scheduled-lambda.ts: file body does NOT falsely document AWSLambdaBasicExecutionRole without implementing it", () => {
    // scheduled-lambda has a doc comment that says "Basic exec role equivalent"
    // but doesn't name AWSLambdaBasicExecutionRole explicitly — however after
    // CP-4 the code DOES attach it. Verify the policy suffix appears in source.
    const filePath = path.join(PATTERNS_DIR, "scheduled-lambda.ts");
    const source = fs.readFileSync(filePath, "utf-8");
    // After CP-4, the code MUST contain LAMBDA_BASIC_EXECUTION_PATH constant reference.
    expect(source).toContain("LAMBDA_BASIC_EXECUTION_PATH");
  });
});
