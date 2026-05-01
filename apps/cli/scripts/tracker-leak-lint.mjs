#!/usr/bin/env node
/**
 * tracker-leak-lint.mjs — CI guard against internal tracker IDs in user-facing CLI strings.
 *
 * Internal tracking references (e.g. "Epic 101", "W3-01", "W4-04") must never
 * appear in strings visible to end users such as command descriptions, option
 * help, argument descriptions, or console output calls. These strings show up
 * in `--help` output and error messages and expose implementation internals.
 *
 * Scanning scope:
 *   apps/cli/src/commands/**\/*.ts
 *
 * Callsites inspected (non-comment string literals only):
 *   .description(   .option(   .argument(   console.log   console.error
 *   process.stderr.write   process.stdout.write
 *
 * Exclusions:
 *   - Lines that are pure comments (trimmed line starts with // or /*)
 *   - *.test.ts files
 *   - apps/cli/src/test-setup.ts
 *   - _bmad-output/, _archive/, .agents/, docs/ trees (not under commands/)
 *
 * Patterns rejected:
 *   - /\bEpic\s+\d+/        e.g. "Epic 101"
 *   - /\bW\d+-\d+\b/        e.g. "W3-01", "W4-04", "W16-S1"
 *
 * Exit codes:
 *   0 — no tracker leaks found.
 *   1 — one or more violations found; details printed to stderr.
 *   2 — fatal (file unreadable or bad arguments).
 *
 * Usage:
 *   pnpm lint:tracker-leak
 *
 * Wired into:
 *   - .github/workflows/ci-core.yml
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const COMMANDS_DIR = resolve(REPO_ROOT, "apps", "cli", "src", "commands");

/**
 * Patterns for internal tracker IDs that must not appear in user-facing strings.
 * Order matters: tested in sequence; first match reports the violation.
 */
const TRACKER_PATTERNS = [
  { re: /\bEpic\s+\d+/, label: "Epic-NN tracker reference" },
  { re: /\bW\d+-\d+\b/, label: "W<wave>-<story> tracker reference" },
];

/**
 * Callsite prefixes whose string content is user-facing.
 * A line qualifies if it contains one of these tokens outside a comment.
 */
const CALLSITE_TOKENS = [
  ".description(",
  ".option(",
  ".argument(",
  "console.log(",
  "console.error(",
  "process.stderr.write(",
  "process.stdout.write(",
];

/**
 * Returns true if the trimmed line is a pure comment (// or block-comment
 * opening /*).  Inline comments on code lines are NOT excluded — only
 * lines where the entire visible content is a comment.
 */
function isPureCommentLine(trimmed) {
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

/**
 * Returns true if the line contains one of the user-facing callsite tokens.
 */
function isUserFacingLine(line) {
  return CALLSITE_TOKENS.some((tok) => line.includes(tok));
}

/**
 * Recursively collect *.ts files under `dir`, excluding *.test.ts, *.d.ts,
 * and common generated directories.
 */
async function collectTsFiles(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = join(d, ent.name);
      if (ent.isDirectory()) {
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
        if (ent.name === "test-setup.ts") continue;
        out.push(abs);
      }
    }
  }
  await walk(dir);
  return out;
}

/**
 * Scan a single file for tracker leaks in user-facing string literals.
 * Returns an array of { file, line, col, text, label } violation objects.
 */
export function scanFileContent(filePath, content) {
  const violations = [];
  const lines = content.split("\n");

  // Track whether we are inside a multi-line string that started on a
  // user-facing callsite line.  We use a simple heuristic: once we enter
  // a callsite line we keep scanning until the expression closes
  // (matching paren depth returns to the level it was at when the
  // callsite opened).  For the current codebase this is sufficient.
  //
  // Implementation note: rather than full AST parsing we scan each line
  // independently.  This catches the vast majority of real cases and is
  // intentionally conservative — we flag any line containing a tracker
  // pattern that also resides on or within a user-facing callsite chain.
  //
  // We accumulate lines that are part of a callsite span and test them
  // collectively.  A callsite span starts on the line that contains one
  // of the CALLSITE_TOKENS and ends when parenthesis depth returns to 0
  // relative to when the callsite token was found.

  let inCallsite = false;
  let parenDepth = 0;
  let callsiteStartLine = 0;
  let spanLines = [];

  const flush = () => {
    if (spanLines.length === 0) return;
    // Only test non-comment lines within the span for tracker leaks.
    const codeLines = spanLines.filter((s) => !isPureCommentLine(s.text.trim()));
    const combined = codeLines.map((s) => s.text).join(" ");
    for (const { re, label } of TRACKER_PATTERNS) {
      if (re.test(combined)) {
        // Find the earliest non-comment line in the span that contains the pattern.
        for (const { lineNo, text } of codeLines) {
          if (re.test(text)) {
            violations.push({ file: filePath, line: lineNo + 1, col: 1, text: text.trim(), label });
            break;
          }
        }
      }
    }
    spanLines = [];
    inCallsite = false;
    parenDepth = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (!inCallsite) {
      // Skip pure comment lines entirely.
      if (isPureCommentLine(trimmed)) continue;

      if (isUserFacingLine(raw)) {
        inCallsite = true;
        callsiteStartLine = i;
        spanLines = [{ lineNo: i, text: raw }];

        // Count paren depth on this first line.
        for (const ch of raw) {
          if (ch === "(") parenDepth++;
          else if (ch === ")") parenDepth--;
        }

        if (parenDepth <= 0) {
          flush();
        }
      }
    } else {
      // Inside an open callsite span — accumulate lines.
      spanLines.push({ lineNo: i, text: raw });

      for (const ch of raw) {
        if (ch === "(") parenDepth++;
        else if (ch === ")") parenDepth--;
      }

      if (parenDepth <= 0) {
        flush();
      }
    }
  }
  // Flush any unclosed span at EOF (shouldn't happen in well-formed code).
  if (inCallsite) flush();

  return violations;
}

/**
 * Scan all command files under `commandsDir` for tracker leaks.
 * Exported for use in tests.
 */
export async function scanCommands(commandsDir = COMMANDS_DIR) {
  const files = await collectTsFiles(commandsDir);
  const allViolations = [];
  for (const abs of files) {
    let content;
    try {
      content = await readFile(abs, "utf8");
    } catch (err) {
      process.stderr.write(
        `tracker-leak-lint: cannot read ${abs}: ${err?.message ?? err}\n`,
      );
      process.exit(2);
    }
    const violations = scanFileContent(abs, content);
    allViolations.push(...violations);
  }
  return allViolations;
}

async function main() {
  let violations;
  try {
    violations = await scanCommands();
  } catch (err) {
    process.stderr.write(
      `tracker-leak-lint: fatal scan error: ${err?.stack ?? err}\n`,
    );
    process.exit(2);
  }

  process.stdout.write(
    `tracker-leak-lint: scanned commands under ${COMMANDS_DIR}\n`,
  );

  if (violations.length === 0) {
    process.stdout.write("tracker-leak-lint: OK — no internal tracker IDs found in user-facing strings.\n");
    return;
  }

  process.stderr.write(
    `tracker-leak-lint: FAIL — ${violations.length} tracker-ID leak(s) found:\n`,
  );
  for (const v of violations) {
    process.stderr.write(`  ${v.file}:${v.line}  [${v.label}]  ${v.text}\n`);
  }
  process.stderr.write(
    "\nFix: replace internal tracking IDs in user-facing strings with user-meaningful language.\n",
  );
  process.exit(1);
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("tracker-leak-lint.mjs");
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`tracker-leak-lint: fatal: ${err?.stack ?? err}\n`);
    process.exit(2);
  });
}

// Export constants for tests.
export { COMMANDS_DIR, TRACKER_PATTERNS, CALLSITE_TOKENS };
