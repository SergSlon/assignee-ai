/**
 * W6-03 — Cost ledger rollup script.
 *
 * Reads per-run JSONL ledger files from `~/.assignee/logs/nightly-cost-*.jsonl`
 * (or `ASSIGNEE_NIGHTLY_LEDGER_DIR`) and produces a weekly aggregation report.
 *
 * Usage:
 *   pnpm tsx scripts/cost-ledger-rollup.ts [--weeks <N>] [--dir <ledger-dir>] [--json]
 *
 * Options:
 *   --weeks <N>   Number of past weeks to aggregate (default: 4)
 *   --dir <path>  Override ledger directory (default: ASSIGNEE_NIGHTLY_LEDGER_DIR or ~/.assignee/logs/)
 *   --json        Emit structured JSON output instead of human-readable table
 *
 * Output (human-readable, per week):
 *   Week 2026-W17  runs: 7  types: 3  successes: 18  failures: 3  totalUsd: $0.0142
 *   ...
 *
 * IMPORTANT: All USD amounts in this script come from the JSONL ledger files,
 * which are populated by `nightly-destroy-smoke.test.ts` using costs fetched
 * from the Pricing MCP at runtime. This script NEVER hardcodes any dollar
 * amounts. (Per feedback_no_hardcoded_prices.)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── CLI args ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  weeks: number;
  dir: string;
  json: boolean;
} {
  let weeks = 4;
  let dir =
    process.env["ASSIGNEE_NIGHTLY_LEDGER_DIR"] ??
    path.join(os.homedir(), ".assignee", "logs");
  let json = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--weeks" && argv[i + 1]) {
      const n = parseInt(argv[++i]!, 10);
      if (Number.isFinite(n) && n > 0) weeks = n;
    } else if (arg === "--dir" && argv[i + 1]) {
      dir = argv[++i]!;
    } else if (arg === "--json") {
      json = true;
    }
  }

  return { weeks, dir, json };
}

// ── Ledger record shape ────────────────────────────────────────────────

interface CostLedgerEntry {
  ts: string;
  resourceType: string;
  region: string;
  provisionSuccess: boolean;
  destroySuccess: boolean;
  estimatedUsd: number | null;
  durationMs: number;
  runId: string;
}

// ── Date helpers ──────────────────────────────────────────────────────

/** ISO week number (1–53) for a given Date. */
function isoWeek(date: Date): number {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNum = d.getUTCDay() || 7; // Monday=1 … Sunday=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

function weekKey(date: Date): string {
  const year = date.getUTCFullYear();
  const week = String(isoWeek(date)).padStart(2, "0");
  return `${year}-W${week}`;
}

/** Returns the Date for `N` weeks ago (Monday 00:00:00 UTC). */
function weeksAgo(n: number): Date {
  const now = new Date();
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  // Rewind to this week's Monday
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - dayOfWeek + 1);
  // Then go back N-1 more weeks
  d.setUTCDate(d.getUTCDate() - (n - 1) * 7);
  return d;
}

// ── File discovery ────────────────────────────────────────────────────

function discoverLedgerFiles(dir: string, since: Date): string[] {
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("nightly-cost-") && f.endsWith(".jsonl"))
    .sort(); // lexicographic = chronological for YYYY-MM-DD filenames

  return files
    .map((f) => path.join(dir, f))
    .filter((filePath) => {
      // Extract date from filename: nightly-cost-YYYY-MM-DD.jsonl
      const match = path
        .basename(filePath)
        .match(/nightly-cost-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match) return false;
      const fileDate = new Date(match[1]! + "T00:00:00Z");
      return fileDate >= since;
    });
}

// ── Ledger parsing ────────────────────────────────────────────────────

function parseJSONL(filePath: string): CostLedgerEntry[] {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as CostLedgerEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is CostLedgerEntry => entry !== null);
  } catch {
    return [];
  }
}

// ── Aggregation ────────────────────────────────────────────────────────

interface WeekSummary {
  weekKey: string;
  runs: Set<string>;
  resourceTypes: Set<string>;
  successCount: number;
  failureCount: number;
  totalUsd: number;
  budgetExceededCount: number;
}

function aggregate(files: string[]): Map<string, WeekSummary> {
  const byWeek = new Map<string, WeekSummary>();

  for (const filePath of files) {
    const entries = parseJSONL(filePath);

    for (const entry of entries) {
      const entryDate = new Date(entry.ts);
      const key = weekKey(entryDate);

      if (!byWeek.has(key)) {
        byWeek.set(key, {
          weekKey: key,
          runs: new Set(),
          resourceTypes: new Set(),
          successCount: 0,
          failureCount: 0,
          totalUsd: 0,
          budgetExceededCount: 0,
        });
      }

      const week = byWeek.get(key)!;
      week.runs.add(entry.runId);

      if (entry.resourceType === "_budget_exceeded_sentinel") {
        week.budgetExceededCount++;
        continue;
      }

      week.resourceTypes.add(entry.resourceType);

      if (entry.provisionSuccess && entry.destroySuccess) {
        week.successCount++;
      } else {
        week.failureCount++;
      }

      if (entry.estimatedUsd !== null && Number.isFinite(entry.estimatedUsd)) {
        week.totalUsd += entry.estimatedUsd;
      }
    }
  }

  return byWeek;
}

// ── Output formatters ─────────────────────────────────────────────────

function formatTable(summaries: WeekSummary[]): string {
  const lines: string[] = [
    "Nightly destroy smoke — cost ledger rollup",
    "─".repeat(80),
  ];

  for (const s of summaries) {
    const budgetNote =
      s.budgetExceededCount > 0
        ? ` [budget-exceeded: ${s.budgetExceededCount}x]`
        : "";
    lines.push(
      `Week ${s.weekKey}  ` +
        `runs: ${s.runs.size}  ` +
        `types: ${s.resourceTypes.size}  ` +
        `successes: ${s.successCount}  ` +
        `failures: ${s.failureCount}  ` +
        `totalUsd: $${s.totalUsd.toFixed(4)}` +
        budgetNote,
    );
  }

  if (summaries.length === 0) {
    lines.push("  (no ledger data found)");
  }

  return lines.join("\n");
}

function formatJSON(summaries: WeekSummary[]): string {
  return JSON.stringify(
    summaries.map((s) => ({
      weekKey: s.weekKey,
      runCount: s.runs.size,
      resourceTypeCount: s.resourceTypes.size,
      resourceTypes: Array.from(s.resourceTypes).sort(),
      successCount: s.successCount,
      failureCount: s.failureCount,
      totalUsd: s.totalUsd,
      budgetExceededCount: s.budgetExceededCount,
    })),
    null,
    2,
  );
}

// ── Entry point ───────────────────────────────────────────────────────

function run(): void {
  const { weeks, dir, json } = parseArgs(process.argv);

  const since = weeksAgo(weeks);
  const files = discoverLedgerFiles(dir, since);

  if (files.length === 0 && !json) {
    console.log(
      `No nightly cost ledger files found in ${dir} for the past ${weeks} week(s).`,
    );
    console.log(
      `Run nightly smoke tests with RUN_E2E=1 to generate ledger data.`,
    );
    process.exit(0);
  }

  const byWeek = aggregate(files);

  // Sort by weekKey ascending
  const sortedSummaries = Array.from(byWeek.values()).sort((a, b) =>
    a.weekKey.localeCompare(b.weekKey),
  );

  if (json) {
    console.log(formatJSON(sortedSummaries));
  } else {
    console.log(formatTable(sortedSummaries));
    console.log(`\nLedger directory: ${dir}`);
    console.log(`Files scanned: ${files.length}`);
    console.log(
      `Period: ${weeks} week(s) since ${since.toISOString().slice(0, 10)}`,
    );
  }
}

run();
