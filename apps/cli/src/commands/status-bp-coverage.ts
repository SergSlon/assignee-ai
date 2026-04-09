/**
 * BP Coverage Dashboard — shows rules per resource type, auto-fix percentage, and coverage gaps.
 *
 * Runtime scanning of packages/best-practices/ — zero hardcoded counts.
 *
 * @see Story 30.7
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";
import chalk from "chalk";
import { SUPPORTED_TYPES_ARRAY } from "@assignee/core";
import { FixType, SKIP_DIRS } from "@assignee/best-practices";
import { UNKNOWN_FALLBACK } from "../config/constants.js";

export interface ResourceTypeCoverage {
  resourceType: string;
  total: number;
  autoFixable: number;
  interactive: number;
  manualOnly: number;
  lastVerified: string;
}

export interface BPCoverageData {
  resourceTypes: ResourceTypeCoverage[];
  summary: {
    totalRules: number;
    autoFixable: number;
    interactive: number;
    manualOnly: number;
    autoFixPercent: number;
  };
  gaps: string[];
  sources: Record<string, number>;
  severityDistribution: Record<string, number>;
}

interface ParsedRule {
  id: string;
  resource_type: string;
  severity: string;
  source: string;
  autoFixable?: boolean;
  fixType?: string;
  lastVerified: string;
}

/**
 * Scan the best-practices directory and compute coverage data.
 */
export function computeBPCoverage(bpDir: string): BPCoverageData {
  const rules: ParsedRule[] = [];

  // Walk service directories
  for (const entry of fs.readdirSync(bpDir)) {
    if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
    const entryPath = path.join(bpDir, entry);
    if (!fs.statSync(entryPath).isDirectory()) continue;

    for (const file of fs.readdirSync(entryPath)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      try {
        const content = fs.readFileSync(path.join(entryPath, file), "utf-8");
        const parsed = parse(content) as ParsedRule;
        if (parsed && parsed.id && parsed.resource_type) {
          rules.push(parsed);
        }
      } catch {
        continue;
      }
    }
  }

  // Group by resource type
  const byType = new Map<string, ParsedRule[]>();
  for (const rule of rules) {
    const existing = byType.get(rule.resource_type) ?? [];
    existing.push(rule);
    byType.set(rule.resource_type, existing);
  }

  // Build resource type coverage
  const resourceTypes: ResourceTypeCoverage[] = [];
  for (const [resourceType, typeRules] of byType.entries()) {
    const autoFix = typeRules.filter((r) => r.autoFixable === true).length;
    const interactive = typeRules.filter(
      (r) => r.fixType === FixType.INTERACTIVE,
    ).length;
    const manual = typeRules.length - autoFix - interactive;
    const lastVerified =
      typeRules
        .map((r) => r.lastVerified)
        .sort()
        .reverse()[0] ?? UNKNOWN_FALLBACK;

    resourceTypes.push({
      resourceType,
      total: typeRules.length,
      autoFixable: autoFix,
      interactive,
      manualOnly: manual,
      lastVerified,
    });
  }

  // Sort by total rules descending
  resourceTypes.sort((a, b) => b.total - a.total);

  // Summary
  const totalAutoFix = rules.filter((r) => r.autoFixable === true).length;
  const totalInteractive = rules.filter(
    (r) => r.fixType === FixType.INTERACTIVE,
  ).length;
  const totalManual = rules.length - totalAutoFix - totalInteractive;

  // Gap analysis — supported types with zero rules
  const coveredTypes = new Set(byType.keys());
  const gaps = SUPPORTED_TYPES_ARRAY.filter((t) => !coveredTypes.has(t));

  // Source breakdown
  const sources: Record<string, number> = {};
  for (const rule of rules) {
    const src = rule.source || UNKNOWN_FALLBACK;
    sources[src] = (sources[src] ?? 0) + 1;
  }

  // Severity distribution
  const severityDistribution: Record<string, number> = {};
  for (const rule of rules) {
    const sev = rule.severity || UNKNOWN_FALLBACK;
    severityDistribution[sev] = (severityDistribution[sev] ?? 0) + 1;
  }

  return {
    resourceTypes,
    summary: {
      totalRules: rules.length,
      autoFixable: totalAutoFix,
      interactive: totalInteractive,
      manualOnly: totalManual,
      autoFixPercent:
        rules.length > 0 ? Math.round((totalAutoFix / rules.length) * 100) : 0,
    },
    gaps,
    sources,
    severityDistribution,
  };
}

/**
 * Render the BP coverage dashboard to stdout.
 */
export function renderBPCoverage(data: BPCoverageData): void {
  process.stdout.write(chalk.bold("\nBP Coverage Dashboard\n"));
  process.stdout.write("=====================\n\n");

  // Main table
  const header = `${"Resource Type".padEnd(42)} ${"Rules".padStart(5)} ${"Auto-Fix".padStart(8)} ${"Interactive".padStart(11)} ${"Manual".padStart(6)} ${"Last Verified".padStart(13)}`;
  process.stdout.write(chalk.gray(header) + "\n");
  process.stdout.write(chalk.gray("─".repeat(header.length)) + "\n");

  for (const rt of data.resourceTypes) {
    process.stdout.write(
      `${rt.resourceType.padEnd(42)} ${String(rt.total).padStart(5)} ${String(rt.autoFixable).padStart(8)} ${String(rt.interactive).padStart(11)} ${String(rt.manualOnly).padStart(6)} ${rt.lastVerified.padStart(13)}\n`,
    );
  }

  // Summary
  process.stdout.write(
    `\nSummary: ${data.summary.totalRules} rules | ${data.summary.autoFixable} auto-fixable (${data.summary.autoFixPercent}%) | ${data.summary.interactive} interactive | ${data.summary.manualOnly} manual\n`,
  );

  // Gap analysis
  if (data.gaps.length > 0) {
    process.stdout.write(chalk.yellow("\nGap Analysis (0 rules):\n"));
    for (const gap of data.gaps) {
      process.stdout.write(`  - ${gap}\n`);
    }
  }

  // Source breakdown
  process.stdout.write("\nSource Breakdown:\n");
  const sourceEntries = Object.entries(data.sources).sort(
    (a, b) => b[1] - a[1],
  );
  const sourceStr = sourceEntries.map(([k, v]) => `${k}: ${v}`).join(" | ");
  process.stdout.write(`  ${sourceStr}\n`);

  // Severity distribution
  process.stdout.write("\nSeverity Distribution:\n");
  const sevEntries = Object.entries(data.severityDistribution);
  const sevStr = sevEntries.map(([k, v]) => `${k}: ${v}`).join(" | ");
  process.stdout.write(`  ${sevStr}\n\n`);
}

/**
 * Render ONLY the list of resource types that have zero BP rules.
 * CI-friendly output for `assignee status --bp-coverage --gaps-only`:
 * no table, no summary, no severity breakdown — just a short
 * list that a shell script can parse line-by-line, and a clear
 * "0 gaps" / "N gaps" header so a failing CI run points at the
 * actual count rather than a dashboard to be manually scanned.
 */
export function renderBPCoverageGaps(gaps: string[]): void {
  if (gaps.length === 0) {
    process.stdout.write(
      chalk.green(
        "0 BP coverage gaps — every supported type has at least one rule.\n",
      ),
    );
    return;
  }
  process.stdout.write(
    chalk.yellow(
      `${gaps.length} BP coverage gap${gaps.length === 1 ? "" : "s"} (types with 0 rules):\n`,
    ),
  );
  for (const gap of gaps) {
    process.stdout.write(`  ${gap}\n`);
  }
}
