#!/usr/bin/env node
/**
 * citation-lint.mjs — full-repo markdown citation checker.
 *
 * Scans README.md, CHANGELOG.md, and docs/**\/*.md for relative
 * markdown/code citations of the form `[label](relative/path.ext)` and
 * verifies each target resolves on disk. Prevents the Step-6c
 * scope-incomplete pattern where isolated citation fixes leave the rest
 * of the repo stale (see Epic 53 L8-006 and Epic 54 it1 L8-B1).
 *
 * - Exit 0: every citation resolves.
 * - Exit 1: one or more broken citations; details printed to stderr.
 *
 * External URLs (http/https/mailto/#anchors), image links inside code
 * fences, and citations whose target is a pure anchor (`#section`) are
 * skipped. Directories count as valid targets.
 *
 * Usage:
 *   node apps/cli/scripts/citation-lint.mjs
 *
 * Wire into `pnpm citation-lint` at the workspace root and run ahead of
 * doc-touching PRs; also safe to run in CI.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".turbo",
  "coverage",
  "_bmad-output",
]);

/**
 * Walk docs/ recursively + pick up README.md/CHANGELOG.md at repo root.
 */
async function collectTargets(root) {
  const files = [];
  const rootEntries = ["README.md", "CHANGELOG.md"];
  for (const name of rootEntries) {
    const full = join(root, name);
    if (existsSync(full)) files.push(full);
  }
  const docsDir = join(root, "docs");
  if (existsSync(docsDir)) await walk(docsDir, files);
  return files;
}

async function walk(dir, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) await walk(abs, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(abs);
  }
}

/**
 * Extract `[label](path)` citations, stripping the `#anchor` suffix and
 * any trailing `"title"` annotation. Skip code-fence blocks so embedded
 * examples do not poison the scan.
 */
function extractCitations(text) {
  const lines = text.split("\n");
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Strip inline code spans so `[x](y)` inside backticks is ignored.
    const stripped = line.replace(/`[^`]*`/g, "");
    // [label](target) — non-greedy, disallow whitespace in target
    const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let match;
    while ((match = re.exec(stripped)) !== null) {
      out.push({ line: i + 1, raw: match[1] });
    }
  }
  return out;
}

function shouldCheck(target) {
  if (!target) return false;
  if (/^(https?:|mailto:|#)/.test(target)) return false;
  // Pure anchor citations with no path component
  if (target.startsWith("#")) return false;
  return true;
}

function stripAnchor(target) {
  const hash = target.indexOf("#");
  return hash === -1 ? target : target.slice(0, hash);
}

async function main() {
  const files = await collectTargets(REPO_ROOT);
  const broken = [];
  let checked = 0;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const citations = extractCitations(text);
    const hostDir = dirname(file);
    for (const { line, raw } of citations) {
      if (!shouldCheck(raw)) continue;
      const pathPart = stripAnchor(raw);
      if (!pathPart) continue;
      checked++;
      const abs = resolve(hostDir, pathPart);
      try {
        await stat(abs);
      } catch {
        broken.push({
          file: relative(REPO_ROOT, file),
          line,
          target: raw,
        });
      }
    }
  }
  const totalBroken = broken.length;
  process.stdout.write(
    `citation-lint: scanned ${files.length} files, ${checked} citations, ${totalBroken} broken\n`,
  );
  if (totalBroken > 0) {
    for (const b of broken) {
      process.stderr.write(`BROKEN  ${b.file}:${b.line}  ${b.target}\n`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`citation-lint: fatal: ${err?.stack ?? err}\n`);
  process.exit(2);
});
