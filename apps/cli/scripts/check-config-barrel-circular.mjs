#!/usr/bin/env node
/**
 * check-config-barrel-circular.mjs — enforce no cross-imports between
 * the 3 config sub-barrels (Story 58-it1-05, closes it57-1-L4-L4).
 *
 * The `packages/core/src/barrels/config.ts` aggregate barrel is split
 * into three domain sub-barrels:
 *
 *   - `config/constants.ts`    — pure constants / enums / classifiers
 *   - `config/resources.ts`    — resource-type, ARN, IAM, config loaders
 *   - `config/help-hints.ts`   — help-hint SSO renderers
 *
 * These MUST NOT import from each other. Cross-imports create a
 * circular dependency hazard and erase the semantic-layer boundary
 * that motivated the split (Story 56-it2-01). This linter fails if
 * any cross-import exists.
 *
 * Exit codes:
 *   0 — no violations.
 *   1 — cross-imports detected.
 *   2 — fatal (missing sub-barrel file).
 *
 * Usage:
 *   pnpm lint:barrels
 *
 * Exports (for the drift-guard test — kept symmetric with
 * `no-new-cli-shims.mjs`):
 *   - `scanCrossImports(configDir)` — returns violations array.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const CONFIG_DIR = resolve(
  REPO_ROOT,
  "packages",
  "core",
  "src",
  "barrels",
  "config",
);

// Sibling sub-barrel names (without `.ts`). Each sub-barrel must
// avoid importing from any of the OTHER two.
const SUB_BARRELS = ["constants", "resources", "help-hints"];

/**
 * Scan each sub-barrel for `from "./<sibling>.js"` imports that would
 * create a circular dependency. Returns an array of
 * `{ file, line, importPath }` violations.
 */
export async function scanCrossImports(configDir = CONFIG_DIR) {
  const violations = [];
  for (const self of SUB_BARRELS) {
    const filePath = resolve(configDir, `${self}.ts`);
    let text;
    try {
      text = await readFile(filePath, "utf8");
    } catch (err) {
      const wrapped = new Error(
        `check-config-barrel-circular: cannot read ${filePath}: ${
          err?.message ?? err
        }`,
      );
      wrapped.code = "ENOENT_SUBBARREL";
      throw wrapped;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const sibling of SUB_BARRELS) {
        if (sibling === self) continue;
        // Matches: `from "./<sibling>.js"` or `from './<sibling>.js'`
        // (standard TS import/export path with the `.js` suffix the
        // repo uses under "module": "nodenext"). Relative paths
        // deeper than `./` are allowed — only the sibling sub-barrel
        // pattern is forbidden.
        const pattern = new RegExp(
          `from\\s+["']\\./${sibling}\\.js["']`,
        );
        if (pattern.test(line)) {
          violations.push({
            file: `${self}.ts`,
            line: i + 1,
            importPath: `./${sibling}.js`,
            text: line.trim(),
          });
        }
      }
    }
  }
  return violations;
}

async function main() {
  let violations;
  try {
    violations = await scanCrossImports();
  } catch (err) {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(2);
  }
  if (violations.length === 0) {
    process.stdout.write(
      `check-config-barrel-circular: OK (${SUB_BARRELS.length} sub-barrels, no cross-imports)\n`,
    );
    return;
  }
  process.stderr.write(
    `check-config-barrel-circular: FAIL — ${violations.length} cross-import(s) ` +
      `between config sub-barrels (circular dependency hazard):\n`,
  );
  for (const v of violations) {
    process.stderr.write(
      `  packages/core/src/barrels/config/${v.file}:${v.line} → ${v.importPath}\n` +
        `      ${v.text}\n`,
    );
  }
  process.stderr.write(
    `Fix: consume the shared symbol through the parent barrel\n` +
      `     (\`packages/core/src/barrels/config.ts\`) or a deeper\n` +
      `     non-sibling path under \`packages/core/src/config/\`.\n`,
  );
  process.exit(1);
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-config-barrel-circular.mjs");
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(
      `check-config-barrel-circular: fatal: ${err?.stack ?? err}\n`,
    );
    process.exit(2);
  });
}

// Re-exported constants so tests can use the same defaults.
export { CONFIG_DIR, SUB_BARRELS };
