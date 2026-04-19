#!/usr/bin/env node
/**
 * no-new-cli-shims.mjs — enforce the CLI stability-shim policy
 * (Story 56-it2-01, closes it56-1-L4-007a).
 *
 * The CLI currently holds ~60 thin re-export shims that bounce symbols
 * from `@assignee/core` back out under `apps/cli/src/**` for legacy
 * test-path stability. This script prevents NEW shims from sneaking in.
 *
 * Policy (docs/explanation/invariants.md → "CLI stability-shim policy"):
 *
 *   - Every file in `apps/cli/src/**` whose first 20 lines contain a
 *     "Thin re-export shim" or "Re-export from @assignee/core" comment
 *     is treated as a known shim.
 *   - The authoritative allow-list lives in
 *     `apps/cli/src/__fixtures__/known-shims.txt` (one path per line,
 *     relative to `apps/cli/src/`, sorted).
 *   - This linter fails (exit 1) when the current shim set differs
 *     from the snapshot:
 *       - NEW shim → fix the code (stop adding shims; import from
 *         `@assignee/core` at the call site instead). Deleting shims
 *         is always welcome; this linter also flags DELETED ones so
 *         the snapshot stays honest.
 *
 * Exit codes:
 *   0 — no drift.
 *   1 — drift detected (new/removed shims). Details to stderr.
 *   2 — fatal (unreadable file, missing snapshot).
 *
 * Usage:
 *   pnpm lint:shims
 *
 * Exports (for the drift-guard test):
 *   - `scanShims(cliSrcRoot)`   — walk the tree; return sorted shim paths.
 *   - `loadSnapshot(fixturePath)` — parse the known-shims.txt file.
 *   - `diffShims(current, snapshot)` — return {added, removed} arrays.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const CLI_SRC = resolve(REPO_ROOT, "apps", "cli", "src");
const FIXTURE = resolve(CLI_SRC, "__fixtures__", "known-shims.txt");

const SHIM_MARKERS = /Thin re-export shim|Re-export from @assignee\/core/;
// Walk only enough of each file to spot the marker — shims put the
// marker in the top-of-file docblock. 20 lines is generous.
const MARKER_SCAN_LINES = 20;

/**
 * Recursively list every `.ts` file under `root`, skipping `.test.ts`,
 * `.d.ts`, and common generated/asset directories.
 */
async function listTsFiles(root) {
  const out = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        // Skip fixture, test-output, and asset directories to keep the
        // scan fast and avoid generated files.
        if (
          ent.name === "node_modules" ||
          ent.name === "dist" ||
          ent.name === "__fixtures__"
        ) {
          continue;
        }
        await walk(abs);
      } else if (ent.isFile()) {
        if (!ent.name.endsWith(".ts")) continue;
        if (ent.name.endsWith(".test.ts")) continue;
        if (ent.name.endsWith(".d.ts")) continue;
        out.push(abs);
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * Return the sorted list of shim paths (relative to `apps/cli/src/`,
 * forward-slash separated) currently present in the tree.
 */
export async function scanShims(cliSrcRoot = CLI_SRC) {
  const files = await listTsFiles(cliSrcRoot);
  const hits = [];
  for (const abs of files) {
    // Read just the prefix — we don't care about the rest.
    let text;
    try {
      text = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    const prefix = text.split("\n", MARKER_SCAN_LINES).join("\n");
    if (SHIM_MARKERS.test(prefix)) {
      const rel = relative(cliSrcRoot, abs).split(sep).join("/");
      hits.push(rel);
    }
  }
  hits.sort();
  return hits;
}

/**
 * Load the snapshot allow-list. Empty lines and lines beginning with `#`
 * are treated as comments.
 */
export async function loadSnapshot(fixturePath = FIXTURE) {
  const raw = await readFile(fixturePath, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .sort();
}

/**
 * Compute diffs between current scan and snapshot. Both arrays must
 * already be sorted.
 */
export function diffShims(current, snapshot) {
  const cur = new Set(current);
  const snap = new Set(snapshot);
  const added = current.filter((p) => !snap.has(p));
  const removed = snapshot.filter((p) => !cur.has(p));
  return { added, removed };
}

async function main() {
  let snapshot;
  try {
    snapshot = await loadSnapshot();
  } catch (err) {
    process.stderr.write(
      `no-new-cli-shims: cannot read snapshot at ${FIXTURE}. ` +
        `Underlying error: ${err?.message ?? err}\n`,
    );
    process.exit(2);
  }

  let current;
  try {
    current = await scanShims();
  } catch (err) {
    process.stderr.write(
      `no-new-cli-shims: scan failed: ${err?.stack ?? err}\n`,
    );
    process.exit(2);
  }

  const { added, removed } = diffShims(current, snapshot);
  process.stdout.write(
    `no-new-cli-shims: known=${snapshot.length} current=${current.length}\n`,
  );
  if (added.length === 0 && removed.length === 0) {
    return;
  }
  if (added.length > 0) {
    process.stderr.write(
      `DRIFT  ${added.length} NEW CLI shim(s) — policy forbids new shims. ` +
        `Import from @assignee/core at the call site instead.\n`,
    );
    for (const p of added) {
      process.stderr.write(`  + ${p}\n`);
    }
  }
  if (removed.length > 0) {
    process.stderr.write(
      `DRIFT  ${removed.length} snapshot shim(s) no longer exist — ` +
        `good! Regenerate the snapshot to keep it honest:\n`,
    );
    for (const p of removed) {
      process.stderr.write(`  - ${p}\n`);
    }
    process.stderr.write(
      `  Regenerate: \`node apps/cli/scripts/no-new-cli-shims.mjs --write\`\n`,
    );
  }
  process.exit(1);
}

/**
 * Regenerate the snapshot from the current tree. Intended for one-off
 * use when legitimately deleting a shim — run with `--write`, review
 * the diff, commit the new snapshot.
 */
async function regenerate() {
  const { writeFile } = await import("node:fs/promises");
  const current = await scanShims();
  const header =
    "# Known CLI stability shims — see docs/explanation/invariants.md\n" +
    "# DO NOT add new shims. Deleting shims is welcome; regenerate via:\n" +
    "#   node apps/cli/scripts/no-new-cli-shims.mjs --write\n";
  const body = current.join("\n") + "\n";
  await writeFile(FIXTURE, header + body, "utf8");
  process.stdout.write(
    `no-new-cli-shims: wrote ${current.length} shim paths to ${FIXTURE}\n`,
  );
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("no-new-cli-shims.mjs");
if (isDirectRun) {
  const writeMode = process.argv.includes("--write");
  (writeMode ? regenerate() : main()).catch((err) => {
    process.stderr.write(
      `no-new-cli-shims: fatal: ${err?.stack ?? err}\n`,
    );
    process.exit(2);
  });
}

// Re-exported constants so tests can use the same defaults.
export { CLI_SRC, FIXTURE };
