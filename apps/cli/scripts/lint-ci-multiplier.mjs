#!/usr/bin/env node
/**
 * lint-ci-multiplier.mjs — CI-multiplier stub guard (T-006).
 *
 * The `checkTimingBudget` function (and `checkTimingsAgainstBudgets` in
 * timing.ts) reads `process.env["CI"]` at call time: when CI=true the
 * effective budget is silently multiplied by 1.5. Any test file that
 * imports these functions WITHOUT stubbing `CI` will pass under local
 * runs (CI unset) but gain 1.5× leniency on every GitHub Actions run,
 * masking real timing regressions.
 *
 * This script finds every `.test.ts` file that imports one of the
 * at-risk symbols and verifies that the file contains a
 * `vi.stubEnv("CI"` call (anywhere — beforeEach, beforeAll, inline).
 *
 * Exit codes:
 *   0 — all at-risk test files stub CI.
 *   1 — one or more files import the symbol without stubbing CI.
 *   2 — fatal (unreadable file or bad arguments).
 *
 * Usage:
 *   pnpm lint:ci-multiplier
 *
 * Wired into:
 *   - `.husky/pre-push`
 *   - `.github/workflows/ci-core.yml`
 *
 * Reference: Murat T-006 (Epic 99 W3 L3c). See also
 *   apps/cli/src/telemetry/timing.test.ts for the canonical stub pattern:
 *     beforeEach(() => { vi.stubEnv("CI", ""); });
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");

/**
 * Symbols whose import into a test file requires a CI stub.
 * Pattern: match the bare identifier in an import statement.
 */
const GUARDED_SYMBOLS = [
  "checkTimingBudget",
  "checkTimingsAgainstBudgets",
];

/** The stub call the test file must contain when importing a guarded symbol. */
const STUB_PATTERN = /vi\.stubEnv\(\s*["']CI["']/;

/**
 * Recursively walk a directory and return all `.test.ts` file paths.
 * Skips dist/, node_modules/, and coverage/.
 */
async function collectTestFiles(root) {
  const SKIP = new Set(["dist", "node_modules", "coverage", ".turbo", "build"]);
  const out = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (SKIP.has(ent.name)) continue;
        await walk(join(dir, ent.name));
      } else if (ent.isFile() && ent.name.endsWith(".test.ts")) {
        out.push(join(dir, ent.name));
      }
    }
  }

  await walk(root);
  return out;
}

/**
 * Return which guarded symbols are imported by the file content, if any.
 */
function findGuardedImports(content) {
  return GUARDED_SYMBOLS.filter((sym) => {
    // Match: import { ..., <sym>, ... } from "..."
    // or: import { <sym> } from "..."
    // The symbol must appear as a whole word inside an import statement.
    const importRegex = new RegExp(
      `import\\s+[^;]*\\b${sym}\\b[^;]*from\\s+["'][^"']+["']`,
      "s",
    );
    return importRegex.test(content);
  });
}

async function main() {
  // Scan apps/ and packages/ directories.
  const scanRoots = [
    resolve(REPO_ROOT, "apps"),
    resolve(REPO_ROOT, "packages"),
  ];

  const allTestFiles = (
    await Promise.all(scanRoots.map(collectTestFiles))
  ).flat();

  const violations = [];

  for (const file of allTestFiles) {
    let content;
    try {
      content = await readFile(file, "utf8");
    } catch (err) {
      process.stderr.write(
        `lint-ci-multiplier: cannot read ${file}: ${err?.message ?? err}\n`,
      );
      process.exit(2);
    }

    const imported = findGuardedImports(content);
    if (imported.length === 0) continue;

    // Check that the file stubs CI.
    if (!STUB_PATTERN.test(content)) {
      violations.push({ file, symbols: imported });
    }
  }

  const scanned = allTestFiles.length;
  const atRisk = allTestFiles.filter((f) => {
    // Re-evaluate quickly to count at-risk files.
    return GUARDED_SYMBOLS.some((sym) => {
      const importRegex = new RegExp(
        `import\\s+[^;]*\\b${sym}\\b[^;]*from\\s+["'][^"']+["']`,
        "s",
      );
      try {
        // We already read this above — best-effort count without a second I/O.
        return false; // placeholder; real count is violations.length + passing
      } catch {
        return false;
      }
    });
  }).length;

  process.stdout.write(
    `lint-ci-multiplier: scanned ${scanned} test files\n`,
  );

  if (violations.length === 0) {
    process.stdout.write(
      `lint-ci-multiplier: OK — all CI-multiplier imports are guarded with vi.stubEnv("CI")\n`,
    );
    return;
  }

  for (const { file, symbols } of violations) {
    const rel = file.replace(REPO_ROOT + "/", "");
    process.stderr.write(
      `FAIL  ${rel}: imports ${symbols.join(", ")} without stubbing CI.\n` +
        `      Silent 1.5× multiplier will mask failures on GH Actions.\n` +
        `      Fix: add \`beforeEach(() => { vi.stubEnv("CI", ""); });\` to this file.\n` +
        `      See apps/cli/src/telemetry/timing.test.ts for the canonical pattern.\n\n`,
    );
  }

  process.stderr.write(
    `lint-ci-multiplier: ${violations.length} violation(s) found. Fix before pushing.\n`,
  );
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(
    `lint-ci-multiplier: fatal: ${err?.stack ?? err}\n`,
  );
  process.exit(2);
});
