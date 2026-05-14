#!/usr/bin/env tsx
/**
 * reviewer-evidence-audit — walks git log and validates that every
 * `Reviewer: ACCEPT` token in a commit body has a corresponding evidence
 * file at _archive/reviews/<short-sha>-review.md with the correct header.
 *
 * Usage:
 *   pnpm reviewer-evidence-audit [--since <ref>] [--limit <n>]
 *
 * Exit 0 if all commits pass; exit 1 if any fail.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let sinceRef = "HEAD~30";
let limit = 30;
let repoRoot = process.cwd();

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--since" && args[i + 1]) {
    sinceRef = args[++i];
  } else if (args[i] === "--limit" && args[i + 1]) {
    limit = parseInt(args[++i], 10);
    if (isNaN(limit) || limit < 1) {
      console.error("--limit must be a positive integer");
      process.exit(1);
    }
  } else if (args[i] === "--repo-root" && args[i + 1]) {
    // Allow callers (tests, CI) to override the root directory
    repoRoot = args[++i];
  }
}

// ---------------------------------------------------------------------------
// Core parsing helpers — exported for testing
// ---------------------------------------------------------------------------

/** Matches the strict ACCEPT format:
 *  Reviewer: ACCEPT — <role> (<persona>) — <story_id> — see _archive/reviews/<sha>-review.md
 *  OR the bootstrap exception:
 *  Reviewer: ACCEPT — bootstrap — <story_id>
 */
const ACCEPT_STRICT_RE =
  /^Reviewer: ACCEPT — .+ \(.+\) — \S+ — see _archive\/reviews\/([a-f0-9]+)-review\.md/m;
const ACCEPT_BOOTSTRAP_RE = /^Reviewer: ACCEPT — bootstrap — \S+/m;

export interface CommitAuditResult {
  sha: string;
  shortSha: string;
  subject: string;
  status: "ok" | "missing-file" | "malformed-header" | "no-accept-token";
  detail?: string;
}

export function parseAcceptToken(
  body: string,
): { type: "strict"; evidenceSha: string } | { type: "bootstrap" } | null {
  const strictMatch = ACCEPT_STRICT_RE.exec(body);
  if (strictMatch) {
    return { type: "strict", evidenceSha: strictMatch[1] };
  }
  if (ACCEPT_BOOTSTRAP_RE.test(body)) {
    return { type: "bootstrap" };
  }
  return null;
}

export function validateEvidenceFile(
  evidenceSha: string,
  archiveDir: string,
): { ok: true } | { ok: false; reason: string } {
  const filePath = join(archiveDir, `${evidenceSha}-review.md`);
  if (!existsSync(filePath)) {
    return {
      ok: false,
      reason: `evidence file missing: ${evidenceSha}-review.md`,
    };
  }
  const content = readFileSync(filePath, "utf8");
  const firstLine = content.split("\n")[0].trim();
  // Required format: # Reviewer: ACCEPT — <role> (<persona>) — <story_id>
  const HEADER_RE = /^# Reviewer: ACCEPT — .+ \(.+\) — \S+/;
  if (!HEADER_RE.test(firstLine)) {
    return {
      ok: false,
      reason: `evidence file has malformed first line: "${firstLine.slice(0, 100)}"`,
    };
  }
  return { ok: true };
}

export function auditCommit(
  sha: string,
  body: string,
  subject: string,
  archiveDir: string,
  git: (cmd: string) => string = defaultGit,
): CommitAuditResult {
  const shortSha = git(`rev-parse --short=8 ${sha}`).trim();

  const token = parseAcceptToken(body);
  if (!token) {
    return {
      sha,
      shortSha,
      subject,
      status: "no-accept-token",
      detail: "no Reviewer: ACCEPT token found",
    };
  }
  if (token.type === "bootstrap") {
    return { sha, shortSha, subject, status: "ok" };
  }

  const check = validateEvidenceFile(token.evidenceSha, archiveDir);
  if (!check.ok) {
    return {
      sha,
      shortSha,
      subject,
      status: check.reason.startsWith("evidence file missing")
        ? "missing-file"
        : "malformed-header",
      detail: check.reason,
    };
  }
  return { sha, shortSha, subject, status: "ok" };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function defaultGit(cmd: string): string {
  return execSync(`git ${cmd}`, { encoding: "utf8" });
}

function getCommitsInRange(
  sinceRefArg: string,
  limitArg: number,
  git: (cmd: string) => string,
): string[] {
  const range = `${sinceRefArg}..HEAD`;
  const raw = git(`log ${range} --format=%H -n ${limitArg} --no-merges`).trim();
  if (!raw) return [];
  return raw.split("\n").filter(Boolean);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const archiveDir = join(repoRoot, "_archive", "reviews");

  let shas: string[];
  try {
    shas = getCommitsInRange(sinceRef, limit, defaultGit);
  } catch (err) {
    console.error(
      `reviewer-evidence-audit: failed to enumerate commits (${sinceRef}..HEAD):`,
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }

  if (shas.length === 0) {
    console.log(
      `reviewer-evidence-audit: no commits in range ${sinceRef}..HEAD — OK`,
    );
    process.exit(0);
  }

  const failures: CommitAuditResult[] = [];
  for (const sha of shas) {
    const body = defaultGit(`log -1 --format=%B ${sha}`);
    const subject = defaultGit(`log -1 --format=%s ${sha}`).trim();

    // Only audit commits that have a Reviewer: ACCEPT token at all
    if (!body.includes("Reviewer: ACCEPT")) continue;

    const result = auditCommit(sha, body, subject, archiveDir);
    if (result.status !== "ok") {
      failures.push(result);
    }
  }

  if (failures.length === 0) {
    console.log(
      `reviewer-evidence-audit: all ${shas.length} commit(s) in range ${sinceRef}..HEAD passed — OK`,
    );
    process.exit(0);
  }

  console.error(
    `\nreviewer-evidence-audit: ${failures.length} commit(s) failed evidence validation:\n`,
  );
  for (const f of failures) {
    console.error(
      `  ${f.shortSha} "${f.subject}"\n    → ${f.status}: ${f.detail}\n`,
    );
  }
  process.exit(1);
}

// Guard so test imports don't trigger the CLI run
if (
  process.argv[1] != null &&
  (process.argv[1].endsWith("reviewer-evidence-audit.ts") ||
    process.argv[1].endsWith("reviewer-evidence-audit.js"))
) {
  main();
}
