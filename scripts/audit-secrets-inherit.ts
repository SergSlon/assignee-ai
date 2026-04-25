#!/usr/bin/env tsx
/**
 * W7-05: audit-secrets-inherit.ts
 *
 * Asserts that no .github/workflows/*.yml uses `secrets: inherit`.
 * `secrets: inherit` passes ALL repository secrets to called workflows,
 * violating least-privilege. Each caller must declare an explicit
 * `secrets:` block listing only the secrets it actually needs.
 *
 * Exit 0 — no `secrets: inherit` found
 * Exit 1 — one or more files contain `secrets: inherit`
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

// Match `secrets: inherit` as a standalone value (not a key named secrets-inherit)
const SECRETS_INHERIT_RE = /^\s+secrets:\s+inherit\s*(?:#.*)?$/m;

interface Finding {
  file: string;
  lineNumbers: number[];
}

function auditFile(filePath: string): Finding | null {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const hits: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (/^\s+secrets:\s+inherit\s*(?:#.*)?$/.test(lines[i])) {
      hits.push(i + 1);
    }
  }

  return hits.length > 0 ? { file: filePath, lineNumbers: hits } : null;
}

function main(): void {
  let files: string[];
  try {
    files = readdirSync(WORKFLOWS_DIR)
      .filter((f) => f.endsWith(".yml") && !f.endsWith(".disabled"))
      .map((f) => join(WORKFLOWS_DIR, f));
  } catch {
    console.log(
      "✓ secrets-inherit audit: no workflows directory found — nothing to check.",
    );
    process.exit(0);
  }

  const findings: Finding[] = [];
  for (const f of files) {
    const result = auditFile(f);
    if (result) findings.push(result);
  }

  if (findings.length === 0) {
    console.log(
      `✓ secrets-inherit audit passed — ${files.length} workflow(s) checked, none use \`secrets: inherit\`.`,
    );
    process.exit(0);
  }

  console.error(
    `✗ secrets-inherit audit FAILED — ${findings.length} workflow(s) use \`secrets: inherit\`:\n`,
  );
  for (const { file, lineNumbers } of findings) {
    const rel = file.replace(ROOT + "/", "");
    console.error(`  ${rel}  (line(s): ${lineNumbers.join(", ")})`);
  }
  console.error(
    "\nFix: replace `secrets: inherit` with an explicit `secrets:` block",
  );
  console.error("listing only the secrets the callee actually needs. Example:");
  console.error("  secrets:");
  console.error(
    "    BEDROCK_LOGGING_VERIFIED: ${{ secrets.BEDROCK_LOGGING_VERIFIED }}",
  );
  console.error("    GIST_TOKEN: ${{ secrets.GIST_TOKEN }}");
  process.exit(1);
}

main();
