#!/usr/bin/env node
/**
 * P070 — FinOps monthly ceiling aggregation script.
 *
 * Reads per-run JSONL ledger files from the directory specified by
 * ASSIGNEE_NIGHTLY_LEDGER_DIR (or the --dir flag) — the same files
 * produced by the nightly-e2e workflow and rolled up weekly by
 * scripts/cost-ledger-rollup.ts.
 *
 * Computes the rolling 30-day total and compares it against the
 * configurable monthly ceiling (ASSIGNEE_FINOPS_MONTHLY_BUDGET_USD,
 * default: 50).
 *
 * Usage (CI — invoked by .github/workflows/finops-monthly-budget.yml):
 *   node scripts/finops-aggregate.mjs [--dir <ledger-dir>] [--budget <usd>]
 *
 * Exit codes:
 *   0 — rolling 30-day spend is within budget
 *   1 — rolling 30-day spend EXCEEDS the monthly ceiling (workflow fails)
 *   2 — no ledger data found (treated as WARNING, not a hard failure,
 *       since a fresh repo may not have any nightly runs yet)
 *
 * IMPORTANT: This script NEVER hardcodes any dollar amounts. The budget
 * ceiling is read from the ASSIGNEE_FINOPS_MONTHLY_BUDGET_USD environment
 * variable (set in the workflow or via repo secret) and defaults to 50
 * only as documentation. All cost figures come from the JSONL ledger
 * which is populated from Pricing MCP at runtime. (Per feedback_no_hardcoded_prices.)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── CLI args ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  let dir =
    process.env["ASSIGNEE_NIGHTLY_LEDGER_DIR"] ??
    path.join(os.homedir(), ".assignee", "logs");
  // Budget read from env first, then --budget flag, then document default.
  // The default of 50 is merely a starting point; operators should configure
  // their own value via the ASSIGNEE_FINOPS_MONTHLY_BUDGET_USD repo secret.
  let budget = Number(process.env["ASSIGNEE_FINOPS_MONTHLY_BUDGET_USD"] ?? 50);

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir" && argv[i + 1]) {
      dir = argv[++i];
    } else if (arg === "--budget" && argv[i + 1]) {
      const n = parseFloat(argv[++i]);
      if (Number.isFinite(n) && n > 0) budget = n;
    }
  }

  return { dir, budget };
}

// ── Date helpers ──────────────────────────────────────────────────────

/** Returns the Date for N days ago (00:00:00 UTC). */
function daysAgo(n) {
  const now = new Date();
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

// ── File discovery ────────────────────────────────────────────────────

/** Discover all nightly-cost-*.jsonl files modified within the past 30 days. */
function discoverLedgerFiles(dir, since) {
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("nightly-cost-") && f.endsWith(".jsonl"))
    .sort(); // lexicographic = chronological for YYYY-MM-DD filenames

  return files
    .map((f) => path.join(dir, f))
    .filter((filePath) => {
      const match = path
        .basename(filePath)
        .match(/nightly-cost-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match) return false;
      const fileDate = new Date(match[1] + "T00:00:00Z");
      return fileDate >= since;
    });
}

// ── Ledger parsing ────────────────────────────────────────────────────

function parseJSONL(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry !== null);
  } catch {
    return [];
  }
}

// ── Main aggregation ──────────────────────────────────────────────────

function aggregateRolling30Day(files) {
  let totalUsd = 0;
  let runCount = 0;
  let entryCount = 0;
  const runIds = new Set();

  for (const filePath of files) {
    const entries = parseJSONL(filePath);
    for (const entry of entries) {
      if (entry.resourceType === "_budget_exceeded_sentinel") continue;
      if (entry.runId) runIds.add(entry.runId);
      if (entry.estimatedUsd !== null && Number.isFinite(entry.estimatedUsd)) {
        totalUsd += entry.estimatedUsd;
      }
      entryCount++;
    }
  }

  runCount = runIds.size;
  return { totalUsd, runCount, entryCount, fileCount: files.length };
}

// ── Entry point ───────────────────────────────────────────────────────

function run() {
  const { dir, budget } = parseArgs(process.argv);
  const since = daysAgo(30);

  console.log(`FinOps monthly ceiling check`);
  console.log(`  Ledger directory : ${dir}`);
  console.log(`  Rolling window   : 30 days (since ${since.toISOString().slice(0, 10)})`);
  console.log(`  Monthly ceiling  : $${budget.toFixed(2)} (ASSIGNEE_FINOPS_MONTHLY_BUDGET_USD)`);
  console.log("");

  const files = discoverLedgerFiles(dir, since);

  if (files.length === 0) {
    console.warn(
      `WARNING: No nightly cost ledger files found in ${dir} for the past 30 days.`
    );
    console.warn(
      `  This is expected for a fresh repository or if the nightly-e2e workflow has`
    );
    console.warn(
      `  not yet run. Treating as non-blocking (exit 2).`
    );
    // Output structured summary for the GitHub step summary even when empty.
    if (process.env["GITHUB_STEP_SUMMARY"]) {
      const summaryLines = [
        "## FinOps monthly ceiling — no data",
        "",
        `No cost ledger files found for the past 30 days in \`${dir}\`.`,
        "",
        `Run the nightly-e2e workflow to generate ledger data.`,
        "",
        `Monthly ceiling: **$${budget.toFixed(2)}** (\`ASSIGNEE_FINOPS_MONTHLY_BUDGET_USD\`)`,
      ].join("\n");
      fs.appendFileSync(process.env["GITHUB_STEP_SUMMARY"], summaryLines + "\n");
    }
    process.exit(2);
  }

  const { totalUsd, runCount, entryCount, fileCount } = aggregateRolling30Day(files);

  const overBudget = totalUsd > budget;
  const utilizationPct = budget > 0 ? ((totalUsd / budget) * 100).toFixed(1) : "N/A";
  const status = overBudget ? "EXCEEDED" : "OK";

  console.log(`  Files scanned    : ${fileCount}`);
  console.log(`  Nightly runs     : ${runCount}`);
  console.log(`  Resource entries : ${entryCount}`);
  console.log(`  Rolling 30d cost : $${totalUsd.toFixed(4)}`);
  console.log(`  Utilization      : ${utilizationPct}% of ceiling`);
  console.log(`  Status           : ${status}`);
  console.log("");

  // Write GitHub step summary if running in CI.
  if (process.env["GITHUB_STEP_SUMMARY"]) {
    const statusIcon = overBudget ? "EXCEEDED" : "OK";
    const summaryLines = [
      `## FinOps monthly ceiling — ${statusIcon}`,
      "",
      `| Metric | Value |`,
      `| ------ | ----- |`,
      `| Rolling 30-day cost | **$${totalUsd.toFixed(4)}** |`,
      `| Monthly ceiling | $${budget.toFixed(2)} |`,
      `| Utilization | ${utilizationPct}% |`,
      `| Nightly runs (30d) | ${runCount} |`,
      `| Resource entries | ${entryCount} |`,
      `| Ledger files scanned | ${fileCount} |`,
      "",
      overBudget
        ? `> **ALERT**: Rolling 30-day CI spend ($${totalUsd.toFixed(4)}) has exceeded the FinOps ceiling ($${budget.toFixed(2)}). Raise \`ASSIGNEE_FINOPS_MONTHLY_BUDGET_USD\` or reduce nightly-e2e scope.`
        : `> Spend is within the configured monthly ceiling.`,
    ].join("\n");
    fs.appendFileSync(process.env["GITHUB_STEP_SUMMARY"], summaryLines + "\n");
  }

  if (overBudget) {
    console.error(
      `ERROR: Rolling 30-day CI spend ($${totalUsd.toFixed(4)}) exceeds ` +
        `FinOps ceiling ($${budget.toFixed(2)}). ` +
        `Set ASSIGNEE_FINOPS_MONTHLY_BUDGET_USD to a higher value to unblock, ` +
        `or reduce the nightly-e2e resource scope.`
    );
    process.exit(1);
  }

  console.log(`Rolling 30-day spend is within the configured ceiling.`);
  process.exit(0);
}

run();
