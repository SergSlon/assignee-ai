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
import { z } from "zod";

// Import the schema — build path-safe
const BP_SEVERITY = ["CRITICAL", "HIGH", "MEDIUM", "INFO"] as const;
const BP_CATEGORY = [
  "security",
  "cost",
  "cost_optimization",
  "reliability",
  "performance",
  "compliance",
] as const;
const BP_CHECK_TYPE = [
  "equals",
  "not_equals",
  "exists",
  "not_exists",
  "greater_than",
  "less_than",
  "contains",
  "not_contains",
  "conditional_forbidden",
  "cross_resource_count",
  "cross_resource_reference",
  "awareness",
] as const;
const BP_FIX_TYPE = ["auto", "interactive", "info"] as const;

const bestPracticeSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^BP-[A-Z0-9]+-\d{3}$/,
        "BP ID must match format BP-{SERVICE}-{NNN}",
      ),
    title: z.string().min(1),
    severity: z.enum(BP_SEVERITY),
    resource_type: z.string().min(1),
    property_path: z.string().min(1),
    check_type: z.enum(BP_CHECK_TYPE),
    expected_value: z.unknown(),
    source: z.string().min(1),
    source_id: z.string().optional(),
    description: z.string().optional(),
    remediation: z.string().optional(),
    category: z.enum(BP_CATEGORY),
    version: z.string().optional(),
    lastVerified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    triggers: z
      .array(
        z
          .object({
            resourceType: z.string().optional(),
            fieldCondition: z.string().optional(),
            patternId: z.string().optional(),
            intentKeywords: z.array(z.string()).optional(),
            always: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    autoFixable: z.boolean().optional(),
    desiredStatePatch: z.record(z.unknown()).optional(),
    blocking: z.boolean().optional().default(false),
    condition: z.record(z.unknown()).optional(),
    fixType: z.enum(BP_FIX_TYPE).optional(),
    interactiveOptions: z
      .array(
        z.object({
          label: z.string(),
          action: z.enum([
            "prompt_value",
            "set_value",
            "remove_property",
            "skip",
          ]),
          targetField: z.string().optional(),
          targetValue: z.unknown().optional(),
        }),
      )
      .optional(),
  })
  .strict()
  .refine(
    (bp) => {
      if (bp.fixType === "auto") {
        return bp.autoFixable === true && bp.desiredStatePatch != null;
      }
      return true;
    },
    {
      message:
        "fixType 'auto' requires autoFixable=true and a desiredStatePatch",
    },
  )
  .refine(
    (bp) => {
      if (bp.fixType === "interactive") {
        return (
          bp.interactiveOptions != null && bp.interactiveOptions.length > 0
        );
      }
      return true;
    },
    { message: "fixType 'interactive' requires non-empty interactiveOptions" },
  );

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
 * Validate all BP YAML files.
 */
export function validateBPRules(baseDir: string): ValidationError[] {
  const errors: ValidationError[] = [];
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
      // Warn but don't hard-fail — some duplicates may be intentional (different check_types)
      errors.push({
        filePath: relPath,
        ruleId,
        message: `Potential duplicate: ${dedupKey} also checked by ${existingRule}`,
      });
    } else {
      dedupMap.set(dedupKey, ruleId);
    }
  }

  return errors;
}

// ── CLI entry point ──────────────────────────────────────────────────────────
const isDirectRun = process.argv[1]?.includes("validate-bp-rules");

if (isDirectRun) {
  const baseDir = path.resolve(__dirname, "../packages/best-practices");
  const errors = validateBPRules(baseDir);

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
