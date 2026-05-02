#!/usr/bin/env tsx
/**
 * PR-012: audit-github-org.ts
 *
 * Scans tracked source files for stale GitHub org references
 * (`assignee-ai/assignee` pattern) and exits non-zero if any are found.
 *
 * Canonical org/repo: SergSlon/assignee-ai
 *
 * Exit 0 — no stale org references found
 * Exit 1 — one or more stale references found (file:line list printed)
 *
 * Usage:
 *   pnpm audit-github-org
 *   npx tsx scripts/audit-github-org.ts
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, extname } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname =
  typeof import.meta.dirname !== "undefined"
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const ROOT = join(__dirname, "..");

// Directories to skip entirely
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".turbo",
  ".pnpm-store",
  // Workspace planning/review artifacts live here — not part of the git repo.
  // They intentionally reference old org names in historical audit reports.
  ".agents",
  "_bmad-output",
]);

// File extensions to scan
const SCAN_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".mts",
  ".json",
  ".md",
  ".sh",
  ".rb",
  ".yml",
  ".yaml",
]);

// Stale patterns to detect — these are literal substrings to search for
const STALE_PATTERNS = [
  "assignee-ai/assignee",
  // Also catch the stale GitHub URL variant that uses assignee-ai org
  // but NOT the /assignee-ai/ log-group path which is an AWS resource name
] as const;

interface Finding {
  file: string;
  line: number;
  column: number;
  text: string;
  pattern: string;
}

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      // Also include files with no extension if they look like shell scripts
      if (SCAN_EXTENSIONS.has(ext) || entry.name === "install.sh") {
        files.push(full);
      }
    }
  }

  return files;
}

// The script's own path — skip self-scanning to avoid false positives from
// the STALE_PATTERNS constant and comments in this file.
const SELF_PATH = fileURLToPath(import.meta.url);

function auditFile(filePath: string): Finding[] {
  // Skip self to avoid false positives from the pattern constants in this file
  if (filePath === SELF_PATH) return [];

  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const lines = content.split("\n");
  const findings: Finding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of STALE_PATTERNS) {
      let col = line.indexOf(pattern);
      while (col !== -1) {
        findings.push({
          file: filePath,
          line: i + 1,
          column: col + 1,
          text: line.trim(),
          pattern,
        });
        col = line.indexOf(pattern, col + 1);
      }
    }
  }

  return findings;
}

function main(): void {
  const allFiles = collectFiles(ROOT);
  const allFindings: Finding[] = [];

  for (const f of allFiles) {
    allFindings.push(...auditFile(f));
  }

  if (allFindings.length === 0) {
    console.log(
      `✓ github-org audit passed — ${allFiles.length} file(s) scanned, no stale org references found.`,
    );
    console.log(`  Canonical org/repo: SergSlon/assignee-ai`);
    process.exit(0);
  }

  console.error(
    `✗ github-org audit FAILED — ${allFindings.length} stale org reference(s) found:\n`,
  );
  for (const { file, line, column, text, pattern } of allFindings) {
    const rel = relative(ROOT, file);
    console.error(`  ${rel}:${line}:${column}  [pattern: "${pattern}"]`);
    console.error(`    ${text}`);
  }
  console.error(
    `\nFix: replace every "${STALE_PATTERNS[0]}" reference with "SergSlon/assignee-ai".`,
  );
  console.error(
    `     Run this script again after fixing to confirm zero findings.`,
  );
  process.exit(1);
}

main();
