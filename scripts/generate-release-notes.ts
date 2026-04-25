/**
 * generate-release-notes.ts — W9-04 (closes L1-F36)
 *
 * Generates external-facing release notes from git log between two refs.
 * Filters BMAD-internal ID patterns so external adopters don't see
 * internal story/epic/wave references.
 *
 * BMAD ID filter strategy: DENYLIST (strip matching tokens from commit
 * subjects before emitting). Chosen over allowlist because commit subjects
 * have free-form content after the conventional-commit prefix; an allowlist
 * would require enumerating every possible external-facing phrase, which is
 * unmaintainable. The denylist is conservative — it strips known-internal
 * patterns only (Epic-N, W9-01, story N, P017, etc.) and leaves the rest
 * of the subject intact.
 *
 * Usage:
 *   npx tsx scripts/generate-release-notes.ts --from v0.1.0 --to v0.2.0
 *   npx tsx scripts/generate-release-notes.ts --from v0.1.0            # to HEAD
 *
 * Output: Markdown emitted to stdout in Keep-a-Changelog format.
 *
 * Commit grouping by conventional-commit type prefix:
 *   feat:  / feature: / add:        → Added
 *   fix:   / bugfix:  / hotfix:    → Fixed
 *   docs:                           → (suppressed — internal)
 *   refactor: / perf:               → Changed
 *   chore: / ci: / build: / test:  → (suppressed — internal)
 *   deprecated:                     → Deprecated
 *   revert:                         → (suppressed — already reversed)
 *   security: / sec:                → Security
 *   remove: / removed:              → Removed
 *   (no prefix / unknown prefix)   → Changed
 *
 * Commits whose subject is entirely empty after BMAD-ID stripping are
 * suppressed (they had nothing external-facing to say).
 *
 * WARNING: Do NOT import from @assignee/core or workspace packages here.
 * This script runs outside the workspace build.
 */

import * as child_process from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParsedCommit {
  hash: string;
  subject: string;
  type: CommitCategory;
}

export type CommitCategory =
  | "Added"
  | "Changed"
  | "Fixed"
  | "Deprecated"
  | "Removed"
  | "Security"
  | "suppressed";

export interface ReleaseNotes {
  from: string;
  to: string;
  categories: Record<Exclude<CommitCategory, "suppressed">, string[]>;
}

// ── BMAD ID denylist pattern ──────────────────────────────────────────────────
//
// Strips the following patterns (case-insensitive) from commit subjects:
//   Epic-N, EpicN        — Epic references
//   W9-01, W9            — Wave-story references
//   story N, story-N     — Story references
//   P017, P065           — Planning-artifact IDs
//   L1-F14, L4-S07       — Lane-finding references
//   R1, R3               — Round references (when standalone, e.g. "R3" only)
//
// Parentheses wrapping the pattern are also stripped, e.g.:
//   "(P017 partial → L1-F14 + L2-F02)" is entirely suppressed.
//
// The pattern is applied after splitting on subject; the result is trimmed.

const BMAD_ID_PATTERNS: RegExp[] = [
  // Epic references: "Epic-N", "Epic N", "EpicN" (N = one or more digits)
  /\bEpic-?\s*\d+\b/gi,
  // Wave-story: "W9-01", "W9" (standalone wave ref)
  /\bW\d+(?:-\d+(?:-\d+)*)?\b/g,
  // Story refs: "story N", "story-N", "stories N", "stories 1-3"
  /\bstor(?:y|ies)\s*-?\s*\d+(?:\s*-\s*\d+)?\b/gi,
  // Planning artifact IDs: P017, P065, P060
  /\bP\d{3,}\b/g,
  // Lane-finding refs: L1-F14, L2-F02, L4-S07, L6-F12
  /\bL\d+-[FS]\d+\b/g,
  // Round refs: R1, R2, R3 (only when surrounded by word boundaries)
  /\bR\d+\b/g,
  // Parenthetical blocks that contain only BMAD IDs, connectors, and whitespace
  // e.g. "(P017 partial -> L1-F14 + L2-F02)" or "(closes L1-F36)"
  /\(\s*(?:closes?\s+|partial\s+|fixes?\s+)?[A-Z0-9\s\-+→>.,;:]+\)/gi,
];

/**
 * Strip BMAD ID patterns from a commit subject string.
 * Returns the cleaned subject (may be empty string if nothing remained).
 */
export function stripBmadIds(subject: string): string {
  let result = subject;
  for (const pattern of BMAD_ID_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, "");
  }
  // Normalise whitespace, strip leading/trailing punctuation and dashes
  result = result.replace(/\s{2,}/g, " ").trim();
  // Strip leading/trailing em-dash, colon, comma, or pipe artefacts
  result = result.replace(/^[\s\-—:,|]+|[\s\-—:,|]+$/g, "").trim();
  return result;
}

// ── Commit type classifier ────────────────────────────────────────────────────

const TYPE_MAP: Array<[RegExp, CommitCategory]> = [
  [/^(feat|feature|add|added)(\(.+?\))?!?:/i, "Added"],
  [/^(fix|bugfix|hotfix|bug)(\(.+?\))?!?:/i, "Fixed"],
  [/^(deprecat)(\(.+?\))?!?:/i, "Deprecated"],
  [/^(remov|delet)(\(.+?\))?!?:/i, "Removed"],
  [/^(security|sec)(\(.+?\))?!?:/i, "Security"],
  [/^(refactor|perf|improve|update|change|changed)(\(.+?\))?!?:/i, "Changed"],
  // Suppressed types — internal only
  [
    /^(docs?|chore|ci|build|test|revert|wip|style|format)(\(.+?\))?!?:/i,
    "suppressed",
  ],
];

/**
 * Determine the Keep-a-Changelog category for a commit subject.
 */
export function classifyCommit(rawSubject: string): CommitCategory {
  for (const [pattern, category] of TYPE_MAP) {
    if (pattern.test(rawSubject)) {
      return category;
    }
  }
  // Unknown prefix or no prefix — treat as Changed
  return "Changed";
}

/**
 * Strip the conventional-commit type prefix from a subject so the
 * display text is the description only.
 *   "feat(ec2): add SSH key support" → "add SSH key support"
 */
export function stripTypePrefix(subject: string): string {
  return subject.replace(/^[a-z]+(?:\(.+?\))?!?:\s*/i, "").trim();
}

// ── Git log reader ────────────────────────────────────────────────────────────

export interface GitLogOptions {
  from: string;
  to: string;
  execSync?: typeof child_process.execSync;
}

export interface RawCommit {
  hash: string;
  subject: string;
}

/**
 * Read git log between `from..to` and return raw commits.
 * If `from` is empty, returns all commits up to `to`.
 */
export function readGitLog(opts: GitLogOptions): RawCommit[] {
  const { from, to, execSync = child_process.execSync } = opts;

  const repoRoot = path.resolve(
    path.dirname(url.fileURLToPath(import.meta.url)),
    "..",
  );

  const range = from ? `${from}..${to}` : to;
  const cmd = `git log --oneline --no-decorate ${range}`;

  let output: string;
  try {
    output = execSync(cmd, {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 30_000,
    }).toString();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git log failed: ${msg}`);
  }

  const lines = output.split("\n").filter((l) => l.trim() !== "");
  return lines.map((line) => {
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx < 0) return { hash: line, subject: "" };
    return {
      hash: line.slice(0, spaceIdx),
      subject: line.slice(spaceIdx + 1),
    };
  });
}

// ── Note builder ──────────────────────────────────────────────────────────────

const EMPTY_CATEGORIES = (): Record<
  Exclude<CommitCategory, "suppressed">,
  string[]
> => ({
  Added: [],
  Changed: [],
  Fixed: [],
  Deprecated: [],
  Removed: [],
  Security: [],
});

/**
 * Build release notes from raw commits.
 */
export function buildReleaseNotes(
  rawCommits: RawCommit[],
  from: string,
  to: string,
): ReleaseNotes {
  const categories = EMPTY_CATEGORIES();

  for (const { subject } of rawCommits) {
    const category = classifyCommit(subject);
    if (category === "suppressed") continue;

    // Strip type prefix, then strip BMAD IDs
    const noPrefix = stripTypePrefix(subject);
    const cleaned = stripBmadIds(noPrefix);

    // If nothing remains after stripping, suppress the commit
    if (cleaned === "") continue;

    // Capitalise first letter
    const entry = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    categories[category].push(entry);
  }

  return { from, to, categories };
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

const CATEGORY_ORDER: Exclude<CommitCategory, "suppressed">[] = [
  "Added",
  "Changed",
  "Fixed",
  "Deprecated",
  "Removed",
  "Security",
];

/**
 * Render release notes as Keep-a-Changelog markdown.
 */
export function renderMarkdown(notes: ReleaseNotes): string {
  const dateStr = new Date().toISOString().slice(0, 10);
  const header = `## [${notes.to}] - ${dateStr}\n`;

  const sections: string[] = [header];

  let hasContent = false;
  for (const category of CATEGORY_ORDER) {
    const items = notes.categories[category];
    if (items.length === 0) continue;
    hasContent = true;
    sections.push(`### ${category}\n`);
    for (const item of items) {
      sections.push(`- ${item}`);
    }
    sections.push("");
  }

  if (!hasContent) {
    sections.push("_No user-facing changes in this release._\n");
  }

  return sections.join("\n");
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { from: string; to: string } {
  let from = "";
  let to = "HEAD";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from" && i + 1 < argv.length) {
      from = argv[++i];
    } else if (argv[i] === "--to" && i + 1 < argv.length) {
      to = argv[++i];
    }
  }

  return { from, to };
}

function main(): void {
  const { from, to } = parseArgs(process.argv.slice(2));

  const rawCommits = readGitLog({ from, to });
  const notes = buildReleaseNotes(rawCommits, from, to);
  const markdown = renderMarkdown(notes);

  process.stdout.write(markdown + "\n");
}

// Only run main() when executed directly
const isMain =
  process.argv[1]?.endsWith("generate-release-notes.ts") ||
  process.argv[1]?.endsWith("generate-release-notes.js");
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error("generate-release-notes: error:", err);
    process.exit(1);
  }
}
