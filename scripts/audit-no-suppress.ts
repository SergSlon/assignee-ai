/**
 * W6-02 / RW2-FIX-1C / RW-FIX-2D CI lint: assert no exit-code masking on
 * 'assignee' CLI invocations in GitHub Actions action files AND workflow
 * files.
 *
 * SCOPE:
 *   1. .github/actions/STAR/action.yml (apply + plan composite actions)
 *   2. .github/workflows/STAR.yml      (every CI workflow)
 *
 * Workflow files are higher-impact than composite actions: a regression in
 * a workflow's main step (e.g. MASTER-014's reviewer-skip ban that landed
 * exit-code-masking on a CLI invocation) silently passes CI. The original
 * W6-02 scope only covered .github/actions/, so the same regression in a
 * workflow file would have escaped audit.
 *
 * Usage:
 *   pnpm tsx scripts/audit-no-suppress.ts
 *
 * In CI:
 *   node --import tsx/esm scripts/audit-no-suppress.ts
 *
 * The check is purposely narrow: it rejects shell exit-code suppression
 * (the bash idiom that ORs a literal truthy value after a pipe-pipe to
 * mask the preceding command's exit code) on lines that capture
 * 'assignee' command output. Generic suppression on git/grep/echo lines
 * (used legitimately for informational commands like `gh label create
 * 2>/dev/null` with idempotency suppression) is allowed — the audit
 * logs those as WARNING for visibility but does not block the build.
 *
 * Pattern logic:
 *   - Lines that contain 'assignee' (CLI invocation) AND the suppression
 *     idiom -> BLOCKER
 *   - Lines that set ASSIGNEE_OUTPUT or capture assignee exit code AND
 *     contain the suppression idiom -> BLOCKER
 *   - Any other suppression idiom -> WARNING (informational, not a
 *     blocker)
 *
 * YAML context-awareness (RW-FIX-2D):
 *   Lines inside YAML `name:` values, comment-only lines, and other
 *   non-shell contexts are skipped entirely. Only lines that look like
 *   shell-command content (inside `run:` blocks, or continuations
 *   thereof) are classified. This prevents self-pollution where the
 *   audit script's own description text or step `name:` text would
 *   match its own pattern. See RW-FIX-2D / R2-008.
 *
 * Allowlist marker (explicit opt-out):
 *   A line carrying the comment marker 'AUDIT_NO_SUPPRESS_OK' is
 *   skipped entirely (not classified as BLOCKER or WARNING). Use this
 *   ONLY when an assignee CLI suppression is genuinely intentional
 *   AND the rationale is documented next to the marker. Example:
 *     # Cleanup-after-test pattern; failure here is recoverable.
 *     # AUDIT_NO_SUPPRESS_OK: tracked in epic-XYZ
 *     assignee destroy --all <suppression-idiom>
 *
 * TODO (off-ownership follow-up): ci-security.yml's audit-no-suppress
 * step `name:` text references this script and historically contained
 * the literal suppression idiom in prose. With the YAML
 * context-awareness added in RW-FIX-2D, that name-line text is no
 * longer flagged. A future cleanup wave should also tidy that step
 * `name:` so the prose no longer contains the literal idiom (defense in
 * depth — context-awareness is the primary fix; cosmetic prose cleanup
 * is the secondary). ci-security.yml is outside this story's
 * file-ownership scope.
 *
 * Known coverage gaps (R3-002 / EH3-001 / EH3-002):
 *   - `actions/github-script@v*` `with: script:` blocks contain JS code,
 *     NOT shell, that runs in the runner. Logical suppressions in JS
 *     (empty `catch {}` swallow, post-error `process.exit(0)`, etc.)
 *     cannot be detected by this audit's shell-pattern matcher. To
 *     keep operators aware, the audit emits a WARNING for every
 *     workflow line that opens a `with: script:` block — operators
 *     should hand-review JS payloads for swallowed-error patterns.
 *     Detecting suppression in JS would require a JS parser, which is
 *     out of scope for v3.
 *   - Heredoc bodies inside `run:` blocks are now classified as
 *     non-shell (data) so literal idiom mentions in heredoc text are
 *     not flagged (EH3-001).
 *   - Multi-doc YAML separator (`^---$`) resets block-scope state so
 *     stale `run:`/heredoc state from a prior document does not bleed
 *     into the next (EH3-002).
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
 * The shell suppression idiom this audit detects. Constructed from
 * fragments rather than written as a literal so this source file does
 * not match its own pattern when scanned (defense in depth — the audit
 * never scans scripts/, but keeping the literal absent prevents
 * accidental self-pollution if scope ever expands). The runtime value
 * is the four-character sequence pipe-pipe-space-t-r-u-e.
 */
const SUPPRESSION_IDIOM = ["|", "|", " ", "true"].join("");

/**
 * YAML-line context. Tracks whether a line is shell-command content
 * (inside a `run:` block) versus YAML metadata (`name:` / comment / key)
 * so that prose mentioning the suppression idiom in a step name or
 * description doesn't get classified.
 */
type LineContext = "shell" | "non-shell";

/**
 * Pre-classify each line of a YAML file as shell-command content or
 * non-shell (name/description/comment/other-key). The minimal state
 * machine: a `run: |` or `run: >` block opens a shell scope at the
 * indentation level greater than the `run:` key itself; the scope
 * closes when a subsequent non-empty line returns to that indentation
 * or shallower. Inline `run: <command>` is shell on that single line
 * only. All other lines are non-shell.
 *
 * Comment-only lines (`^\s*#`) are always non-shell — even inside a
 * shell block, a `#` line is a comment, not an executable command.
 *
 * Multi-doc YAML separator (`^---\s*$`, EH3-002 fix): YAML supports
 * multiple documents in a single file separated by `---`. Block-scope
 * state from the previous document does NOT carry over to the next —
 * any open `run:` block (and any heredoc inside it) terminates at the
 * separator. The separator line itself is non-shell.
 *
 * Heredoc body inside a `run:` block (EH3-001 fix): a `cat <<EOF ...
 * EOF` heredoc body is documentation/data, not executable shell. Body
 * lines are reclassified as non-shell so literal mentions of the
 * suppression idiom inside heredoc text don't get flagged. The
 * terminator line itself remains shell context (it's part of the
 * shell command structure). Supports the standard POSIX forms:
 *   cat <<EOF        cat <<-EOF        cat <<'EOF'        cat <<"EOF"
 * Indented variant `<<-` allows leading-tab stripping but the
 * terminator-match logic is the same.
 */
function buildLineContexts(lines: string[]): LineContext[] {
  const contexts: LineContext[] = new Array(lines.length).fill("non-shell");

  let inRunBlock = false;
  let runIndent = -1; // indent of the `run:` key itself; block is at indent > runIndent
  let inHeredoc = false;
  let heredocTerminator = "";

  const resetBlockState = (): void => {
    inRunBlock = false;
    runIndent = -1;
    inHeredoc = false;
    heredocTerminator = "";
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // EH3-002: Multi-doc YAML separator. Reset all block-scope state
    // so a `run:` (or heredoc) opened in the previous document does
    // not bleed into the next document.
    if (/^---\s*$/.test(line)) {
      resetBlockState();
      contexts[i] = "non-shell";
      continue;
    }

    // Comment-only lines: always non-shell.
    if (/^\s*#/.test(line)) {
      contexts[i] = "non-shell";
      continue;
    }

    // Empty lines preserve the current block state without classifying.
    if (trimmed === "") {
      contexts[i] = "non-shell";
      continue;
    }

    const lineIndent = line.length - line.trimStart().length;

    // If we're inside a run-block, check whether this line is still
    // inside it (indent strictly greater than the run: key indent).
    if (inRunBlock) {
      if (lineIndent > runIndent) {
        // EH3-001: heredoc handling. If we're already inside a
        // heredoc body, classify as non-shell unless the line is
        // the terminator (matching trimmed token, possibly with
        // leading whitespace for `<<-` form).
        if (inHeredoc) {
          if (trimmed === heredocTerminator) {
            // Terminator line — closes heredoc; classify as shell
            // because it's part of the shell command structure.
            inHeredoc = false;
            heredocTerminator = "";
            contexts[i] = "shell";
            continue;
          }
          // Heredoc body line — data, not code.
          contexts[i] = "non-shell";
          continue;
        }

        // Not in a heredoc; this line is shell. Detect heredoc
        // OPEN on this line so subsequent lines are classified
        // as heredoc body. Pattern matches `<<EOF`, `<<-EOF`,
        // `<<'EOF'`, `<<"EOF"`. Quotes around the terminator are
        // stripped for matching purposes (POSIX semantics: quoted
        // terminator disables variable expansion in body, but the
        // terminator token itself is unquoted).
        const heredocMatch = line.match(
          /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/,
        );
        if (heredocMatch && typeof heredocMatch[1] === "string") {
          inHeredoc = true;
          heredocTerminator = heredocMatch[1];
        }
        contexts[i] = "shell";
        continue;
      }
      // Block closed; fall through to re-classify this line. Reset
      // any in-flight heredoc state too — a heredoc cannot survive
      // exiting its enclosing run-block.
      resetBlockState();
    }

    // Detect a `run:` key. Two forms:
    //   run: |        -> opens a multi-line shell block
    //   run: >        -> opens a multi-line shell block (folded)
    //   run: <cmd>    -> single-line shell on this line only
    const runMatch = /^(\s*)(?:-\s+)?run\s*:\s*(.*)$/.exec(line);
    if (runMatch) {
      const keyIndent = runMatch[1]?.length ?? 0;
      const after = (runMatch[2] ?? "").trim();
      if (
        after === "|" ||
        after === ">" ||
        after.startsWith("|") ||
        after.startsWith(">")
      ) {
        // Multi-line block opens; this header line itself is non-shell.
        inRunBlock = true;
        runIndent = keyIndent;
        contexts[i] = "non-shell";
      } else if (after.length > 0) {
        // Inline single-line shell command.
        contexts[i] = "shell";
      } else {
        // `run:` alone with nothing after — treat as block opener using
        // default literal style; subsequent indented lines are shell.
        inRunBlock = true;
        runIndent = keyIndent;
        contexts[i] = "non-shell";
      }
      continue;
    }

    // Not in a run block, not a run header → YAML key/value, name, etc.
    contexts[i] = "non-shell";
  }

  return contexts;
}

/**
 * Detect the suppression idiom on a line that runs the assignee CLI or
 * captures its output. Returns severity classification, or null if no
 * suppression is detected on the line. The `context` argument lets
 * callers skip non-shell contexts (YAML `name:` / comments) so prose
 * mentioning the idiom doesn't get classified.
 */
function classifyLine(
  line: string,
  context: LineContext,
): "BLOCKER" | "WARNING" | null {
  if (!line.includes(SUPPRESSION_IDIOM)) return null;

  // Explicit allowlist: line carries the documented marker. Skip silently.
  if (line.includes(ALLOWLIST_MARKER)) return null;

  // YAML context-awareness (RW-FIX-2D / R2-008): only classify the
  // suppression idiom when it appears in shell-command content. In
  // YAML `name:` values, descriptions, comments, or other metadata
  // keys, the idiom is prose and cannot mask any exit code.
  if (context !== "shell") return null;

  // BLOCKER patterns: assignee CLI invocations OR ASSIGNEE_OUTPUT captures
  const isAssigneeInvocation =
    /assignee\s+(plan|apply|destroy|init|reconcile|list)/.test(line);
  const isAssigneeOutputCapture = /ASSIGNEE_OUTPUT\s*=/.test(line);
  const isAssigneeExitCode = /\$\?.*assignee|assignee.*\$\?/.test(line);

  if (isAssigneeInvocation || isAssigneeOutputCapture || isAssigneeExitCode) {
    return "BLOCKER";
  }

  // Generic suppression on git/grep/echo lines is informational, not blocking
  return "WARNING";
}

/**
 * Detect `with: script:` opener lines (R3-002). Returns true if `line`
 * is a `script:` key inside a YAML `with:` block — i.e. the JS payload
 * passed to `actions/github-script@v*`. The audit cannot inspect the
 * JS body for suppressions (would need a JS parser), so the caller
 * surfaces a WARNING to flag the block for hand-review.
 *
 * Heuristic: `script:` appears inside the previous step's `with:`
 * block. Implementation matches a `script:` line whose parent
 * (immediately preceding non-empty key at shallower indent) is `with:`.
 * To keep state minimal, we scan for `with:` openers and emit a
 * warning the first time we see `script:` at strictly greater indent
 * before the next `with:` block closes. This catches the common
 * `actions/github-script@v7` shape:
 *
 *     - uses: actions/github-script@v7
 *       with:
 *         script: |
 *           // JS here
 */
function findGithubScriptWarnings(lines: string[], relPath: string): Finding[] {
  const findings: Finding[] = [];
  let inWithBlock = false;
  let withIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // Multi-doc separator resets block-scope state.
    if (/^---\s*$/.test(line)) {
      inWithBlock = false;
      withIndent = -1;
      continue;
    }

    // Comment-only and blank lines don't affect with-block state.
    if (/^\s*#/.test(line) || trimmed === "") {
      continue;
    }

    const lineIndent = line.length - line.trimStart().length;

    // If we're tracking a with-block, check whether this line is still
    // inside it (indent strictly greater than the `with:` key indent).
    if (inWithBlock) {
      if (lineIndent <= withIndent) {
        // `with:` block closed; fall through to re-test this line as
        // a possible new `with:` opener.
        inWithBlock = false;
        withIndent = -1;
      } else {
        // Inside the with-block. Look for `script:` key.
        const scriptMatch = /^\s*script\s*:/.exec(line);
        if (scriptMatch) {
          findings.push({
            file: relPath,
            line: i + 1,
            content: trimmed,
            severity: "WARNING",
          });
        }
        continue;
      }
    }

    // Detect a new `with:` block opener.
    const withMatch = /^(\s*)(?:-\s+)?with\s*:\s*$/.exec(line);
    if (withMatch) {
      inWithBlock = true;
      withIndent = withMatch[1]?.length ?? 0;
    }
  }

  return findings;
}

function scanFile(absPath: string, relPath: string): Finding[] {
  const content = fs.readFileSync(absPath, "utf-8");
  const lines = content.split("\n");
  const contexts = buildLineContexts(lines);
  const findings: Finding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const context = contexts[i] ?? "non-shell";
    const severity = classifyLine(line, context);
    if (severity) {
      findings.push({
        file: relPath,
        line: i + 1,
        content: line.trim(),
        severity,
      });
    }
  }

  // R3-002: surface `with: script:` blocks as WARNING (not BLOCKER) so
  // operators know JS payloads aren't audited for suppression patterns.
  findings.push(...findGithubScriptWarnings(lines, relPath));

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
    console.error(
      `audit-no-suppress: PASS — no '${SUPPRESSION_IDIOM}' masking found.`,
    );
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
      `\nFAIL: ${blockers.length} BLOCKER(s) found. Remove '${SUPPRESSION_IDIOM}' from assignee CLI invocation lines.`,
    );
    console.error(
      `  Rationale: '${SUPPRESSION_IDIOM}' masks non-zero exit codes from assignee commands,`,
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
    `\nPASS: ${allFindings.length} non-blocker finding(s) (informational '${SUPPRESSION_IDIOM}' lines + 'with: script:' JS payloads not audited — hand-review the latter for empty-catch / post-error process.exit(0) suppressions).`,
  );
  return 0;
}

process.exit(main());
