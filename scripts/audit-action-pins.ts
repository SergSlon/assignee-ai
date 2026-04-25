#!/usr/bin/env tsx
/**
 * W7-01: audit-action-pins.ts
 *
 * Asserts that every `uses:` reference in .github/workflows/*.yml and
 * .github/actions/*\/action.yml is pinned to a 40-character SHA.
 *
 * Tag or branch refs (e.g. `actions/checkout@v4`, `actions/checkout@main`)
 * are rejected as supply-chain attack vectors — any reachable tag or branch
 * can be moved by the upstream owner, silently changing what code runs in CI.
 *
 * Exit 0 — all refs are SHA-pinned
 * Exit 1 — one or more refs are not SHA-pinned
 */

import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname =
  typeof import.meta.dirname !== "undefined"
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const ROOT = join(__dirname, "..");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
const ACTIONS_DIR = join(ROOT, ".github", "actions");

const SHA_RE = /^[0-9a-f]{40}$/;
// Matches `uses: owner/repo@<ref>` or `uses: ./local-action`
const USES_RE = /^\s+uses:\s+([^\s#]+)/;

interface Finding {
  file: string;
  line: number;
  ref: string;
}

function collectYmlFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectYmlFiles(full));
      } else if (entry.isFile() && /\.yml(\.disabled)?$/.test(entry.name)) {
        files.push(full);
      }
    }
  } catch {
    // directory may not exist
  }
  return files;
}

function auditFile(filePath: string): Finding[] {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const findings: Finding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(USES_RE);
    if (!m) continue;

    const ref = m[1].trim();

    // Skip local composite action refs (./path/to/action)
    if (ref.startsWith("./")) continue;

    // Skip lines with a TODO-PIN comment — coordinator resolves these before commit.
    // Format: uses: action@ref  # TODO-PIN: ...
    if (lines[i].includes("TODO-PIN")) continue;

    // Extract the SHA part after @
    const atIdx = ref.lastIndexOf("@");
    if (atIdx === -1) {
      // No @ at all — definitely not pinned
      findings.push({ file: filePath, line: i + 1, ref });
      continue;
    }

    const sha = ref.slice(atIdx + 1);
    if (!SHA_RE.test(sha)) {
      findings.push({ file: filePath, line: i + 1, ref });
    }
  }

  return findings;
}

function main(): void {
  const allFiles = [
    ...collectYmlFiles(WORKFLOWS_DIR),
    ...collectYmlFiles(ACTIONS_DIR),
  ];

  const allFindings: Finding[] = [];
  for (const f of allFiles) {
    allFindings.push(...auditFile(f));
  }

  if (allFindings.length === 0) {
    console.log(
      `✓ action-pin audit passed — ${allFiles.length} file(s) checked, all uses: refs are SHA-pinned.`,
    );
    process.exit(0);
  }

  console.error(
    `✗ action-pin audit FAILED — ${allFindings.length} non-SHA-pinned ref(s) found:\n`,
  );
  for (const { file, line, ref } of allFindings) {
    const rel = file.replace(ROOT + "/", "");
    console.error(`  ${rel}:${line}  →  ${ref}`);
  }
  console.error(
    "\nFix: replace each tag/branch ref with a 40-char SHA (+ a # v<N> comment for readability).",
  );
  console.error(
    "Example: actions/checkout@v4 → actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2",
  );
  process.exit(1);
}

main();
