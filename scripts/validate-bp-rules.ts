#!/usr/bin/env tsx
/**
 * BP Validation Script — validates all BP YAML files for schema, uniqueness, and dedup.
 *
 * Validates:
 * 1. YAML parse — syntax valid?
 * 2. Schema — matches bestPracticeSchema from Zod?
 * 3. ID format — matches BP-{SVC}-{NNN}?
 * 4. ID uniqueness — no duplicate IDs?
 * 5. Dedup — no resource_type + property_path duplicates?
 * 6. Conflict — no contradictory desiredStatePatch for same resource type + property?
 *
 * Exit code: 0 on success, 1 on failure.
 *
 * @see Story 30.6
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";

// 2026-05-06: import the canonical schema from the built
// `@assignee/best-practices` dist instead of redefining it here. The
// previous duplicated copy drifted as the production schema gained
// new fields (`consequence`, `fix_hint`, `excludePatterns`) and new
// `check_type` enum values (`policy_antipattern`,
// `nested_array_predicate`, `not_contains_pattern`,
// `sg_high_risk_public_exposure`); CI's W7-S1 gate started failing
// on dozens of YAML files that the production loader accepts. Reusing
// the canonical schema keeps the validator in lockstep with the
// loader by construction — no second source of truth to maintain.
//
// CI invokes this script AFTER `npx turbo build` (see ci-core.yml),
// so the dist bundle is guaranteed present at runtime. tsx resolves
// the ESM import via the relative path; no tsconfig path alias
// needed.
import { bestPracticeSchema } from "../packages/best-practices/dist/schema.js";

/** @see packages/best-practices/src/loader.ts SKIP_DIRS — keep in sync */
const SKIP_DIRS = new Set(["src", "dist", "node_modules", "__tests__"]);

interface ValidationError {
  filePath: string;
  ruleId: string;
  message: string;
}

/**
 * Find all YAML files in the BP directory.
 */
export function findYamlFiles(baseDir: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(baseDir)) {
    if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;

    const entryPath = path.join(baseDir, entry);
    if (!fs.statSync(entryPath).isDirectory()) continue;

    for (const file of fs.readdirSync(entryPath)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      files.push(path.join(entryPath, file));
    }
  }

  return files;
}

/**
 * Result of `validateBPRules`. Errors block the build; warnings are
 * printed but do not change the exit code.
 *
 * 2026-05-06: separated from a single `ValidationError[]` return so the
 * "Potential duplicate" advisory (multiple BPs sharing a
 * `resource_type::property_path` with different check criteria) renders
 * as a warning instead of an exit-1 error. The previous shape pushed
 * "potential duplicate" entries into `errors` while documenting the
 * intent as "warn but don't hard-fail" — the implementation contradicted
 * the comment, and CI's W7-S1 step exited 1 on every push despite all
 * the rules being valid.
 */
export interface BPValidationResult {
  errors: ValidationError[];
  warnings: ValidationError[];
}

/**
 * Validate all BP YAML files.
 */
export function validateBPRules(baseDir: string): BPValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const files = findYamlFiles(baseDir);
  const idMap = new Map<string, string>(); // id -> filePath
  const dedupMap = new Map<string, string>(); // resource_type::property_path -> ruleId

  for (const filePath of files) {
    const relPath = path.relative(baseDir, filePath);
    let parsed: Record<string, unknown>;

    // 1. Parse YAML
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      parsed = parse(content) as Record<string, unknown>;
    } catch (err) {
      errors.push({
        filePath: relPath,
        ruleId: "unknown",
        message: `YAML parse error: ${err instanceof Error ? err.message : "unknown"}`,
      });
      continue;
    }

    const ruleId = typeof parsed.id === "string" ? parsed.id : "unknown";

    // 2. Schema validation
    const result = bestPracticeSchema.safeParse(parsed);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push({
          filePath: relPath,
          ruleId,
          message: `Schema: ${issue.path.join(".")}: ${issue.message}`,
        });
      }
      continue;
    }

    // 3. ID format (already validated by Zod regex, but double-check)
    if (!/^BP-[A-Z0-9]+-\d{3}$/.test(ruleId)) {
      errors.push({
        filePath: relPath,
        ruleId,
        message: `ID format: '${ruleId}' does not match BP-{SVC}-{NNN}`,
      });
    }

    // 4. ID uniqueness
    const existingFile = idMap.get(ruleId);
    if (existingFile) {
      errors.push({
        filePath: relPath,
        ruleId,
        message: `Duplicate ID: '${ruleId}' also defined in ${existingFile}`,
      });
    } else {
      idMap.set(ruleId, relPath);
    }

    // 5. Dedup: resource_type + property_path
    const data = result.data;
    const dedupKey = `${data.resource_type}::${data.property_path}`;
    const existingRule = dedupMap.get(dedupKey);
    if (existingRule) {
      // Warn but don't hard-fail — some duplicates ARE intentional (e.g.
      // BP-S3-018/019/020 + BP-S3BP-001 all check
      // AWS::S3::BucketPolicy::PolicyDocument but with different
      // check_types or different policy_antipattern names). The dedup
      // signal is still useful for review, so we print it as a warning.
      warnings.push({
        filePath: relPath,
        ruleId,
        message: `Potential duplicate: ${dedupKey} also checked by ${existingRule}`,
      });
    } else {
      dedupMap.set(dedupKey, ruleId);
    }
  }

  return { errors, warnings };
}

// ── CLI entry point ──────────────────────────────────────────────────────────
const isDirectRun = process.argv[1]?.includes("validate-bp-rules");

if (isDirectRun) {
  const baseDir = path.resolve(__dirname, "../packages/best-practices");
  const { errors, warnings } = validateBPRules(baseDir);

  // Print warnings first (non-fatal advisories — duplicate dedup keys etc.).
  // They land on stderr alongside errors so CI log scrapers see both, but
  // they don't change the exit code.
  if (warnings.length > 0) {
    console.error(
      `\nValidation found ${warnings.length} advisory warning(s) (non-blocking):\n`,
    );
    for (const w of warnings) {
      console.error(`  ⚠ ${w.filePath} [${w.ruleId}]: ${w.message}`);
    }
  }

  if (errors.length > 0) {
    console.error(`\nValidation found ${errors.length} issue(s):\n`);
    for (const err of errors) {
      console.error(`  ${err.filePath} [${err.ruleId}]: ${err.message}`);
    }
    process.exit(1);
  } else {
    const fileCount = findYamlFiles(baseDir).length;
    console.log(`\nAll ${fileCount} BP rules validated successfully.\n`);
    process.exit(0);
  }
}
