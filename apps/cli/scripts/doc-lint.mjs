#!/usr/bin/env node
/**
 * doc-lint.mjs — narrative-count drift guard for public docs.
 *
 * Extends the Story 54-it1-04 SSO work: the help-hints module derives
 * runtime hint strings from `SUPPORTED_TYPES_ARRAY` and
 * `defaultPatternRegistry` so terminal-surface drift is impossible.
 * This linter closes the remaining gap — the static narrative counts
 * in `README.md` and `docs/integration-architecture.md` that cannot be
 * rendered from a registry at build time.
 *
 * Guards two assertions (Story 56-it1-04, closes it56-1-L3-002):
 *
 *   1. `README.md` pattern-table row count must equal
 *      `defaultPatternRegistry.size()`. The table is located by
 *      scanning for the `| Pattern |` header between the
 *      "Compound architecture patterns" heading and the next `---`
 *      horizontal rule.
 *
 *   2. `docs/integration-architecture.md` narrative counts for
 *      "N user-addressable resource type", "N registered plugins",
 *      "N compound architecture patterns", "N strategies" and
 *      "N decomposers" must match the runtime registry values.
 *
 * Exit codes:
 *   0 — every narrative count matches runtime.
 *   1 — drift detected; details printed to stderr.
 *   2 — fatal (unreadable file, missing registry import, etc.).
 *
 * Usage:
 *   pnpm doc-lint
 *
 * Dependencies: requires `packages/core/dist/` to be built (same
 * constraint as `scripts/check-mock-fixture-drift.mts`). Run
 * `pnpm build` first in a fresh checkout.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");

/**
 * Load runtime registry counts from the built `@assignee/core` dist.
 * Throws a friendly message if the dist is missing so CI surfaces the
 * actionable "run pnpm build" hint rather than a raw ESM resolve error.
 */
async function loadRuntimeCounts() {
  const coreDist = join(REPO_ROOT, "packages", "core", "dist", "index.js");
  let mod;
  try {
    mod = await import(coreDist);
  } catch (err) {
    throw new Error(
      `doc-lint: cannot import @assignee/core dist from ${coreDist}. ` +
        `Run \`pnpm build\` first. Underlying error: ${err?.message ?? err}`,
    );
  }
  const {
    SUPPORTED_TYPES_ARRAY,
    defaultPatternRegistry,
    defaultPricingRegistry,
  } = mod;
  if (!Array.isArray(SUPPORTED_TYPES_ARRAY)) {
    throw new Error("doc-lint: SUPPORTED_TYPES_ARRAY export missing");
  }
  if (!defaultPatternRegistry || typeof defaultPatternRegistry.size !== "function") {
    throw new Error("doc-lint: defaultPatternRegistry export missing");
  }
  if (
    !defaultPricingRegistry ||
    typeof defaultPricingRegistry.registeredTypes !== "function"
  ) {
    throw new Error("doc-lint: defaultPricingRegistry export missing");
  }
  const supportedTypeCount = SUPPORTED_TYPES_ARRAY.length;
  return {
    supportedTypeCount,
    patternCount: defaultPatternRegistry.size(),
    strategyCount: defaultPricingRegistry.registeredTypes().length,
    // Parity is enforced by `packages/core/src/pricing/decomposers/coverage.test.ts`
    // so the decomposer count always equals the supported-type count.
    // Walking the registry directly would require exposing a `.size()` /
    // `.list()` method that currently doesn't exist; the parity test is
    // the authoritative guard.
    decomposerCount: supportedTypeCount,
  };
}

/**
 * Count rows in the README pattern table. Returns null if the table
 * cannot be located — caller surfaces a clear error in that case.
 *
 * The table is identified by the first `| Pattern |` header followed
 * by a divider row (`| :----…`), then data rows until a blank line or
 * heading boundary. This is resilient to small shifts in the line
 * numbering (README gets edited frequently).
 */
export function countReadmePatternRows(readmeText) {
  const lines = readmeText.split("\n");
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^\|\s*Pattern\s*\|/.test(l)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return null;
  // Expect divider row at headerIdx+1, data rows start at headerIdx+2.
  const divider = lines[headerIdx + 1] ?? "";
  if (!/^\|\s*[:-]+/.test(divider)) return null;
  let count = 0;
  for (let i = headerIdx + 2; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l || !l.trim().startsWith("|")) break;
    count += 1;
  }
  return count;
}

/**
 * Extract narrative counts from integration-architecture.md.
 *
 * Returns an object of {matcherLabel: extractedCount} for every
 * pattern the linter guards. A `null` extracted count means the
 * matcher didn't fire — treated as a drift error so future prose
 * rewrites can't silently escape the guard.
 */
export function extractIntegrationArchitectureCounts(docText) {
  const patterns = [
    {
      label: "user-addressable resource types",
      // "All 37 user-addressable resource type constants"
      re: /All\s+(\d+)\s+user-addressable\s+resource\s+type/i,
      expect: "supportedTypeCount",
    },
    {
      label: "registered plugins",
      // "Resource plugin registry (37 registered plugins:"
      re: /Resource plugin registry \((\d+)\s+registered plugins/i,
      expect: "supportedTypeCount",
    },
    {
      label: "compound architecture patterns",
      // "Pattern template registry (10 compound architecture patterns)"
      re: /Pattern template registry \((\d+)\s+compound architecture patterns\)/i,
      expect: "patternCount",
    },
    {
      label: "pricing strategies",
      // "Pricing strategy registry (23 strategies)"
      re: /Pricing strategy registry \((\d+)\s+strategies\)/i,
      expect: "strategyCount",
    },
    {
      label: "pricing decomposers",
      // "decomposer registry (23 decomposers)"
      re: /decomposer registry \((\d+)\s+decomposers\)/i,
      expect: "decomposerCount",
    },
  ];
  const results = [];
  for (const p of patterns) {
    const m = p.re.exec(docText);
    results.push({
      label: p.label,
      expect: p.expect,
      actual: m ? Number.parseInt(m[1], 10) : null,
    });
  }
  return results;
}

/**
 * Run every assertion. Exported so the test suite can feed drifted
 * temp fixtures in and assert the linter reports violations.
 */
export async function runDocLint({
  readmePath,
  integrationArchPath,
  runtimeCounts,
}) {
  const errors = [];
  const readmeText = await readFile(readmePath, "utf8");
  const rows = countReadmePatternRows(readmeText);
  if (rows === null) {
    errors.push(
      `README pattern-table header not found in ${readmePath}. ` +
        `Expected a \`| Pattern | ... |\` row.`,
    );
  } else if (rows !== runtimeCounts.patternCount) {
    errors.push(
      `README pattern-table has ${rows} rows but ` +
        `defaultPatternRegistry.size() === ${runtimeCounts.patternCount}. ` +
        `Update the table in ${readmePath} or re-register the missing pattern(s).`,
    );
  }

  const archText = await readFile(integrationArchPath, "utf8");
  const extracted = extractIntegrationArchitectureCounts(archText);
  for (const { label, expect, actual } of extracted) {
    const expected = runtimeCounts[expect];
    if (actual === null) {
      errors.push(
        `integration-architecture narrative for "${label}" not found in ${integrationArchPath}. ` +
          `The linter regex no longer matches — either the prose was rewritten ` +
          `(update the regex in doc-lint.mjs) or the count sentence was deleted.`,
      );
    } else if (actual !== expected) {
      errors.push(
        `integration-architecture narrative "${label}" says ${actual} but ` +
          `runtime registry reports ${expected}. ` +
          `Update ${integrationArchPath} or the registry.`,
      );
    }
  }
  return errors;
}

async function main() {
  const runtimeCounts = await loadRuntimeCounts();
  const errors = await runDocLint({
    readmePath: join(REPO_ROOT, "README.md"),
    integrationArchPath: join(REPO_ROOT, "docs", "integration-architecture.md"),
    runtimeCounts,
  });
  process.stdout.write(
    `doc-lint: patterns=${runtimeCounts.patternCount} ` +
      `types=${runtimeCounts.supportedTypeCount} ` +
      `strategies=${runtimeCounts.strategyCount} ` +
      `decomposers=${runtimeCounts.decomposerCount}\n`,
  );
  if (errors.length > 0) {
    for (const e of errors) {
      process.stderr.write(`DRIFT  ${e}\n`);
    }
    process.exit(1);
  }
}

// Only run main() when invoked as a script. The module is also imported
// by `apps/cli/src/__tests__/doc-lint.test.ts` which calls the exported
// helpers directly against temp fixtures.
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("doc-lint.mjs");
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`doc-lint: fatal: ${err?.stack ?? err}\n`);
    process.exit(2);
  });
}
