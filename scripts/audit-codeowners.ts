/**
 * audit-codeowners.ts — W9-02 (P020 + P065 → L4-S07)
 *
 * CI lint: asserts CODEOWNERS exists at repo root and is well-formed.
 *
 * Checks:
 *   1. File exists at <repo-root>/CODEOWNERS
 *   2. Every non-comment, non-blank line is a valid ownership entry:
 *      <glob-pattern> @<handle> (one or more space-separated handles)
 *   3. A global catch-all (`* @<handle>`) is present
 *
 * Usage:
 *   npx tsx scripts/audit-codeowners.ts
 *
 * Exit 0 on success; non-zero with actionable message on failure.
 *
 * WARNING: Do NOT import from @assignee/core or workspace packages here.
 * This script runs at CI pre-check time before workspace packages are built.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

// ── Config ────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "..",
);

const CODEOWNERS_PATH = path.join(REPO_ROOT, "CODEOWNERS");

// A valid ownership entry line: <pattern> followed by one or more @handles
// Pattern can be any path glob; handles must start with @
const OWNERSHIP_LINE_RE = /^\S+\s+@\S+(\s+@\S+)*\s*$/;

// The global catch-all pattern — must be present
const CATCHALL_RE = /^\*\s+@\S+/;

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  // 1. File must exist
  if (!fs.existsSync(CODEOWNERS_PATH)) {
    console.error(
      `audit-codeowners: FAIL — CODEOWNERS not found at ${CODEOWNERS_PATH}`,
    );
    console.error(
      "  Create CODEOWNERS at the repository root with at least a global catch-all:",
    );
    console.error("    * @your-github-handle");
    process.exit(1);
  }

  const raw = fs.readFileSync(CODEOWNERS_PATH, "utf-8");
  const lines = raw.split("\n");

  const errors: string[] = [];
  let hasCatchAll = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip blank lines and comment lines
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }

    // Must be a valid ownership entry
    if (!OWNERSHIP_LINE_RE.test(line.trim())) {
      errors.push(
        `  Line ${lineNum}: invalid ownership entry: ${JSON.stringify(line)}`,
      );
      errors.push("    Expected format: <pattern> @handle1 [@handle2 ...]");
      continue;
    }

    // Check for catch-all
    if (CATCHALL_RE.test(line.trim())) {
      hasCatchAll = true;
    }
  }

  // 3. Global catch-all required
  if (!hasCatchAll) {
    errors.push(
      "  Missing global catch-all entry. Add a line like: * @your-github-handle",
    );
  }

  if (errors.length > 0) {
    console.error("audit-codeowners: FAIL");
    for (const err of errors) {
      console.error(err);
    }
    process.exit(1);
  }

  console.log(
    `audit-codeowners: OK — CODEOWNERS present and well-formed (${lines.length} lines)`,
  );
}

main();
