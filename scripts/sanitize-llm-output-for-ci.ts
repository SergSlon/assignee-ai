#!/usr/bin/env tsx
/**
 * W7-04: sanitize-llm-output-for-ci.ts
 *
 * Validates LLM-emitted content against a strict pattern allowlist before
 * it is used inside CI scripts (especially actions/github-script template
 * literals). Rejects known injection attack patterns:
 *
 *   - Template-literal injection:  ${...}  `...`
 *   - Environment variable exfil:  process.env.SECRET, process.env["SECRET"]
 *   - Unicode escape attacks:      `, \x60 (backtick bypass)
 *   - Shell injection in CI:       ${{ secrets.* }}, require('child_process')
 *   - Prototype pollution:         __proto__, constructor.prototype
 *   - Script tags / eval:          <script>, eval(, Function(
 *
 * Usage:
 *   npx tsx scripts/sanitize-llm-output-for-ci.ts <input-file>
 *   cat llm-output.txt | npx tsx scripts/sanitize-llm-output-for-ci.ts -
 *
 * Exit 0 — content is safe per the allowlist
 * Exit 1 — content contains one or more blocked patterns
 */

import { readFileSync } from "fs";

// ─────────────────────────────────────────────────────────────────────────────
// Blocked patterns with explanations
// ─────────────────────────────────────────────────────────────────────────────
interface BlockedPattern {
  name: string;
  pattern: RegExp;
  description: string;
}

const BLOCKED_PATTERNS: BlockedPattern[] = [
  {
    name: "template-literal-injection",
    pattern: /\$\{[^}]*\}/,
    description:
      "Template literal expression ${...} — injects arbitrary JS when content is embedded in a template string.",
  },
  {
    name: "backtick-template",
    pattern: /`[^`]*`/,
    description:
      "Backtick template literal — can execute embedded expressions when eval'd or passed to Function().",
  },
  {
    name: "process-env-access",
    pattern: /process\.env(?:\.\w+|\[['"][^'"]+['"]\])/,
    description: "Direct process.env access — exfiltrates environment secrets.",
  },
  {
    name: "github-actions-expression",
    pattern: /\$\{\{[^}]*\}\}/,
    description:
      "GitHub Actions expression syntax ${{ }} — bypasses secret masking when injected into workflow YAML.",
  },
  {
    name: "unicode-escape-backtick",
    pattern: /\\u0060|\\x60/i,
    description:
      "Unicode/hex escape for backtick — bypasses literal backtick detection.",
  },
  {
    name: "unicode-escape-dollar",
    pattern: /\\u0024|\\x24/i,
    description:
      "Unicode/hex escape for $ — bypasses template injection detection.",
  },
  {
    name: "require-dangerous-module",
    pattern:
      /require\s*\(\s*['"](?:child_process|fs|path|os|net|http|https|crypto|vm|module|cluster)['"]\s*\)/,
    description:
      "require() of a dangerous Node.js built-in — enables shell execution or file access.",
  },
  {
    name: "dynamic-eval",
    pattern: /(?:^|\b)eval\s*\(/,
    description: "eval() call — arbitrary code execution.",
  },
  {
    name: "function-constructor",
    pattern: /new\s+Function\s*\(/,
    description:
      "new Function() constructor — arbitrary code execution via string eval.",
  },
  {
    name: "script-tag",
    pattern: /<script\b/i,
    description:
      "HTML <script> tag — XSS when content is rendered in a GitHub issue/PR comment.",
  },
  {
    name: "prototype-pollution",
    pattern: /__proto__|constructor\.prototype|Object\.prototype/,
    description: "Prototype pollution attempt.",
  },
  {
    name: "github-token-exfil",
    pattern: /GITHUB_TOKEN|GH_TOKEN|secrets\.\w+/i,
    description:
      "Reference to GitHub token or secret name — potential credential exfiltration.",
  },
  {
    name: "shell-command-substitution",
    pattern: /\$\([^)]*\)/,
    description:
      "Shell command substitution $() — executes arbitrary commands if passed to bash.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Allowlist exceptions — benign patterns that might false-positive
// ─────────────────────────────────────────────────────────────────────────────
// These are substring matches applied AFTER the blocked pattern fires.
// If the full line matches an allowlist entry, the blocked finding is suppressed.
const ALLOWLIST_EXCEPTIONS: RegExp[] = [
  // Markdown code blocks showing examples (triple-backtick fenced)
  /^```/,
  // Comment lines
  /^\s*(?:\/\/|#|<!--)/,
  // Literal documentation of the pattern (e.g. "avoid using ${...}")
  /avoid|do not|prohibited|blocked|example of bad/i,
];

interface Finding {
  lineNumber: number;
  line: string;
  pattern: BlockedPattern;
}

function isAllowlisted(line: string): boolean {
  return ALLOWLIST_EXCEPTIONS.some((re) => re.test(line));
}

function sanitize(content: string): Finding[] {
  const lines = content.split("\n");
  const findings: Finding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isAllowlisted(line)) continue;

    for (const blocked of BLOCKED_PATTERNS) {
      if (blocked.pattern.test(line)) {
        findings.push({
          lineNumber: i + 1,
          line: line.slice(0, 200),
          pattern: blocked,
        });
        break; // one finding per line — report the first match
      }
    }
  }

  return findings;
}

function readInput(args: string[]): string {
  const target = args[2];
  if (!target || target === "-") {
    // Read from stdin
    return readFileSync("/dev/stdin", "utf8");
  }
  return readFileSync(target, "utf8");
}

function main(): void {
  let content: string;
  try {
    content = readInput(process.argv);
  } catch (err) {
    console.error(
      `✗ sanitize-llm-output: could not read input — ${(err as Error).message}`,
    );
    process.exit(1);
  }

  const findings = sanitize(content);

  if (findings.length === 0) {
    console.log(
      "✓ sanitize-llm-output: content passed all checks — no injection patterns detected.",
    );
    process.exit(0);
  }

  console.error(
    `✗ sanitize-llm-output FAILED — ${findings.length} blocked pattern(s) detected:\n`,
  );
  for (const { lineNumber, line, pattern } of findings) {
    console.error(
      `  Line ${lineNumber} [${pattern.name}]: ${pattern.description}`,
    );
    console.error(`    → ${line}`);
    console.error("");
  }
  console.error(
    "Blocked content must not be interpolated into CI scripts or GitHub Actions templates.",
  );
  console.error(
    "Use the file-artefact pattern instead: write LLM output to a file, read it in the script.",
  );
  process.exit(1);
}

main();
