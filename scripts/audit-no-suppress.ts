/**
 * W6-02 CI lint: assert no '|| true' masking exit codes in GitHub Actions
 * action files. Exits 1 if any masking is found; exits 0 otherwise.
 *
 * SCOPE: Only checks .github/actions/STAR/action.yml files (apply + plan).
 * Workflow files under .github/workflows/ are checked separately by
 * GitHub's own linter and by Worker C's gate.
 *
 * Usage:
 *   pnpm tsx scripts/audit-no-suppress.ts
 *
 * In CI:
 *   node --import tsx/esm scripts/audit-no-suppress.ts
 *
 * The check is purposely narrow: it rejects '|| true' on lines that
 * capture 'assignee' command output (lines with '|| true' immediately
 * after an 'assignee' invocation or ASSIGNEE_OUTPUT capture). Generic
 * '|| true' on git/grep/echo lines (used legitimately to suppress
 * non-zero exits for informational commands) are allowed.
 *
 * Pattern logic:
 *   - Lines that contain 'assignee' (CLI invocation) AND '|| true' -> BLOCKER
 *   - Lines that set ASSIGNEE_OUTPUT or capture assignee exit code AND contain '|| true' -> BLOCKER
 *   - Any other '|| true' -> warning only (informational, not a blocker)
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Configuration

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const ACTION_FILES = [
  ".github/actions/apply/action.yml",
  ".github/actions/plan/action.yml",
];

interface Finding {
  file: string;
  line: number;
  content: string;
  severity: "BLOCKER" | "WARNING";
}

/**
 * Detect '|| true' masking on a line that runs the assignee CLI or captures
 * its output. Returns severity classification.
 */
function classifyLine(line: string): "BLOCKER" | "WARNING" | null {
  if (!line.includes("|| true")) return null;

  // BLOCKER patterns: assignee CLI invocations OR ASSIGNEE_OUTPUT captures
  const isAssigneeInvocation =
    /assignee\s+(plan|apply|destroy|init|reconcile|list)/.test(line);
  const isAssigneeOutputCapture = /ASSIGNEE_OUTPUT\s*=/.test(line);
  const isAssigneeExitCode = /\$\?.*assignee|assignee.*\$\?/.test(line);

  if (isAssigneeInvocation || isAssigneeOutputCapture || isAssigneeExitCode) {
    return "BLOCKER";
  }

  // Generic '|| true' on git/grep/echo lines is informational, not blocking
  return "WARNING";
}

function scanFile(absPath: string, relPath: string): Finding[] {
  const content = fs.readFileSync(absPath, "utf-8");
  const lines = content.split("\n");
  const findings: Finding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const severity = classifyLine(line);
    if (severity) {
      findings.push({
        file: relPath,
        line: i + 1,
        content: line.trim(),
        severity,
      });
    }
  }

  return findings;
}

// Main

function main(): number {
  const allFindings: Finding[] = [];

  for (const relPath of ACTION_FILES) {
    const absPath = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(absPath)) {
      console.error(`audit-no-suppress: WARNING — file not found: ${relPath}`);
      continue;
    }
    const findings = scanFile(absPath, relPath);
    allFindings.push(...findings);
  }

  if (allFindings.length === 0) {
    console.error("audit-no-suppress: PASS — no '|| true' masking found.");
    return 0;
  }

  const blockers = allFindings.filter((f) => f.severity === "BLOCKER");

  console.error("\naudit-no-suppress findings:");
  for (const finding of allFindings) {
    const marker = finding.severity === "BLOCKER" ? "[BLOCKER]" : "[WARNING]";
    console.error(
      `  ${marker} ${finding.file}:${finding.line}  --  ${finding.content}`,
    );
  }

  if (blockers.length > 0) {
    console.error(
      `\nFAIL: ${blockers.length} BLOCKER(s) found. Remove '|| true' from assignee CLI invocation lines.`,
    );
    console.error(
      "  Rationale: '|| true' masks non-zero exit codes from assignee commands,",
    );
    console.error("  making CI appear green when the command actually failed.");
    console.error("  Per W6-02: silent failures in CI are a BLOCKER finding.");
    return 1;
  }

  console.error(
    `\nPASS: ${allFindings.length} non-blocker '|| true' line(s) found (allowed informational use).`,
  );
  return 0;
}

process.exit(main());
