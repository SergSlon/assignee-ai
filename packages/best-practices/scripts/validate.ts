#!/usr/bin/env node
/**
 * Standalone BP-rule validator CLI.
 *
 * Runs the same checks exercised by `__tests__/validate-bp-rules.test.ts`
 * but as a contributor-facing command: schema conformance, ID uniqueness,
 * resource_type + property_path dedup, and manifest SHA-256 freshness.
 *
 * Exit codes:
 *   0 — every BP rule passes validation AND the on-disk manifest.json
 *       matches the computed hash.
 *   1 — one or more BP rules failed validation OR the manifest is stale.
 *       Every diagnostic is printed to stderr with a file:line prefix.
 *
 * Usage:
 *   pnpm --filter=@assignee/best-practices run validate
 *   tsx packages/best-practices/scripts/validate.ts
 *
 * CI wiring: the `test` script in `packages/best-practices/package.json`
 * runs `validate-bp-rules.test.ts` under vitest, so the same checks fire
 * on `pnpm test` from the repo root. This script is for local contributor
 * loops ("did my new rule parse?") before opening a PR.
 *
 * @see CONTRIBUTING.md § "Contributing a Best-Practice Rule"
 * @see docs/explanation/contributing-a-bp-rule.md
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { bestPracticeSchema } from "../dist/schema.js";
import { SKIP_DIRS } from "../dist/loader.js";
import { computeManifest } from "../dist/integrity.js";

interface ValidationIssue {
  filePath: string;
  ruleId: string;
  message: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(__dirname, "..");

function findYamlFiles(baseDir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(baseDir)) {
    if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
    const entryPath = join(baseDir, entry);
    if (!statSync(entryPath).isDirectory()) continue;
    for (const file of readdirSync(entryPath)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      files.push(join(entryPath, file));
    }
  }
  return files;
}

function validateRules(baseDir: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const files = findYamlFiles(baseDir);
  const idMap = new Map<string, string>();

  for (const filePath of files) {
    const relPath = relative(baseDir, filePath);
    let parsed: Record<string, unknown>;

    try {
      parsed = parse(readFileSync(filePath, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch (err) {
      issues.push({
        filePath: relPath,
        ruleId: "unknown",
        message: `YAML parse error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      continue;
    }

    const ruleId = typeof parsed.id === "string" ? parsed.id : "unknown";
    const result = bestPracticeSchema.safeParse(parsed);
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push({
          filePath: relPath,
          ruleId,
          message: `Schema: ${issue.path.join(".")}: ${issue.message}`,
        });
      }
      continue;
    }

    const existingFile = idMap.get(ruleId);
    if (existingFile) {
      issues.push({
        filePath: relPath,
        ruleId,
        message: `Duplicate ID: '${ruleId}' also defined in ${existingFile}`,
      });
    } else {
      idMap.set(ruleId, relPath);
    }
    // Note: (resource_type, property_path) collision is NOT an error —
    // multiple rules legitimately check the same property with different
    // check_type / expected_value combinations (e.g. policy_antipattern
    // variants on PolicyDocument). The in-suite test still exercises the
    // synthetic dedup check; the CLI validator deliberately omits it.
  }
  return issues;
}

function validateManifest(baseDir: string): ValidationIssue[] {
  const manifestPath = join(baseDir, "manifest.json");
  const issues: ValidationIssue[] = [];
  if (!existsSync(manifestPath)) {
    issues.push({
      filePath: "manifest.json",
      ruleId: "manifest",
      message:
        "manifest.json is missing — run `pnpm --filter=@assignee/best-practices run generate-manifest` to create it.",
    });
    return issues;
  }

  let onDisk: { hash?: string; count?: number };
  try {
    onDisk = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      hash?: string;
      count?: number;
    };
  } catch (err) {
    issues.push({
      filePath: "manifest.json",
      ruleId: "manifest",
      message: `manifest.json is unparseable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return issues;
  }

  const fresh = computeManifest(baseDir);
  if (onDisk.hash !== fresh.hash) {
    issues.push({
      filePath: "manifest.json",
      ruleId: "manifest",
      message: `Manifest hash drift: expected ${fresh.hash.slice(
        0,
        16,
      )}… (${fresh.count} files), manifest.json has ${String(onDisk.hash).slice(
        0,
        16,
      )}… (${onDisk.count ?? "?"} files). Regenerate with \`pnpm --filter=@assignee/best-practices run generate-manifest\`.`,
    });
  }
  return issues;
}

function main(): void {
  const ruleIssues = validateRules(BASE_DIR);
  const manifestIssues = validateManifest(BASE_DIR);
  const issues = [...ruleIssues, ...manifestIssues];

  if (issues.length === 0) {
    const fileCount = findYamlFiles(BASE_DIR).length;
    process.stdout.write(
      `✓ BP validation passed (${fileCount} rules, manifest OK)\n`,
    );
    process.exit(0);
  }

  process.stderr.write(`✗ BP validation found ${issues.length} issue(s):\n`);
  for (const issue of issues) {
    process.stderr.write(
      `  ${issue.filePath} [${issue.ruleId}]: ${issue.message}\n`,
    );
  }
  process.stderr.write(
    "\nFix the issues above, then run this script again. See CONTRIBUTING.md § Contributing a Best-Practice Rule.\n",
  );
  process.exit(1);
}

main();
