/**
 * W6-02 / RW2-FIX-1C CI lint: assert no '|| true' masking exit codes in
 * GitHub Actions action files AND workflow files.
 *
 * SCOPE:
 *   1. .github/actions/STAR/action.yml (apply + plan composite actions)
 *   2. .github/workflows/STAR.yml      (every CI workflow)
 *
 * Workflow files are higher-impact than composite actions: a regression in
 * a workflow's main step (e.g. MASTER-014's reviewer-skip ban that landed
 * a `|| true` on a CLI invocation) silently passes CI. The original W6-02
 * scope only covered .github/actions/, so the same regression in a
 * workflow file would have escaped audit.
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
 * non-zero exits for informational commands like `gh label create
 * 2>/dev/null || true` for idempotency) are allowed — the audit logs
 * them as WARNING for visibility but does not block the build.
 *
 * Pattern logic:
 *   - Lines that contain 'assignee' (CLI invocation) AND '|| true' -> BLOCKER
 *   - Lines that set ASSIGNEE_OUTPUT or capture assignee exit code AND
 *     contain '|| true' -> BLOCKER
 *   - Any other '|| true' -> WARNING (informational, not a blocker)
 *
 * Allowlist marker (explicit opt-out):
 *   A line containing the comment marker 'AUDIT_NO_SUPPRESS_OK' is
 *   skipped entirely (not classified as BLOCKER or WARNING). Use this
 *   ONLY when an assignee CLI suppression is genuinely intentional
 *   AND the rationale is documented next to the marker. Example:
 *     # Cleanup-after-test pattern; failure here is recoverable.
 *     # AUDIT_NO_SUPPRESS_OK: tracked in epic-XYZ
 *     assignee destroy --all || true
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Configuration

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const ACTION_FILES = [
  ".github/actions/apply/action.yml",
  ".github/actions/plan/action.yml",
];

const WORKFLOWS_DIR = ".github/workflows";

/**
 * Comment marker that explicitly allowlists a line. Use sparingly and
 * always document the rationale in a neighbouring comment.
 */
const ALLOWLIST_MARKER = "AUDIT_NO_SUPPRESS_OK";

interface Finding {
  file: string;
  line: number;
  content: string;
  severity: "BLOCKER" | "WARNING";
}

/**
 * Detect '|| true' masking on a line that runs the assignee CLI or captures
 * its output. Returns severity classification, or null if no masking is
 * detected on the line.
 */
function classifyLine(line: string): "BLOCKER" | "WARNING" | null {
  if (!line.includes("|| true")) return null;

  // Explicit allowlist: line carries the documented marker. Skip silently.
  if (line.includes(ALLOWLIST_MARKER)) return null;

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

/**
 * Enumerate workflow files under .github/workflows/ matching *.yml or *.yaml.
 * Skips disabled workflows (`*.yml.disabled`).
 */
function discoverWorkflowFiles(): string[] {
  const absDir = path.join(REPO_ROOT, WORKFLOWS_DIR);
  if (!fs.existsSync(absDir)) return [];

  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    // Match active workflow files: *.yml or *.yaml. Disabled workflows
    // (e.g. test-actions.yml.disabled) are excluded — they aren't
    // executed by GitHub Actions and shouldn't gate the audit.
    if (name.endsWith(".yml") || name.endsWith(".yaml")) {
      out.push(path.join(WORKFLOWS_DIR, name));
    }
  }
  out.sort();
  return out;
}

// Main

function main(): number {
  const allFindings: Finding[] = [];
  const scannedFiles: string[] = [];

  // Scope 1: composite action files (apply + plan)
  for (const relPath of ACTION_FILES) {
    const absPath = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(absPath)) {
      console.error(`audit-no-suppress: WARNING — file not found: ${relPath}`);
      continue;
    }
    scannedFiles.push(relPath);
    const findings = scanFile(absPath, relPath);
    allFindings.push(...findings);
  }

  // Scope 2: workflow files (RW2-FIX-1C extension)
  const workflowFiles = discoverWorkflowFiles();
  for (const relPath of workflowFiles) {
    const absPath = path.join(REPO_ROOT, relPath);
    scannedFiles.push(relPath);
    const findings = scanFile(absPath, relPath);
    allFindings.push(...findings);
  }

  console.error(
    `audit-no-suppress: scanned ${scannedFiles.length} file(s) (${ACTION_FILES.length} action(s) + ${workflowFiles.length} workflow(s)).`,
  );

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
    console.error(
      `  Allowlist (use sparingly): add '${ALLOWLIST_MARKER}' comment on the line if`,
    );
    console.error(
      "  the suppression is intentional, and document the rationale.",
    );
    return 1;
  }

  console.error(
    `\nPASS: ${allFindings.length} non-blocker '|| true' line(s) found (allowed informational use).`,
  );
  return 0;
}

process.exit(main());
