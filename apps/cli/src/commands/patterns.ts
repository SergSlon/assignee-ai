/**
 * `assignee patterns` command — discover the compound architecture
 * patterns the CLI can auto-route natural-language intents to.
 *
 * Subcommands:
 *   - `assignee patterns list` (default): print all registered
 *     compound patterns with display name, resource count, and
 *     the first few keywords, in registration (= precedence) order.
 *   - `assignee patterns show <patternId>`: print the full resource
 *     list, dependency order, and every keyword for a single
 *     pattern.
 *
 * Both subcommands support `--json` for machine-readable output.
 *
 * Why this lives in its own command: the compound-pattern surface
 * has grown to 10 patterns and 4 of them landed in the same session
 * (efs-with-vpc, scheduled-lambda, plus the IAM+Lambda split). The
 * only way to discover them today is to grep the source or read
 * docs/resource-types.md, neither of which is zero-friction. A
 * dedicated `patterns` subcommand is the natural CLI-native answer.
 */

import { Command } from "commander";
import { defaultPatternRegistry } from "@assignee/core";
import type { ArchitecturePattern } from "@assignee/core";

interface PatternListEntry {
  patternId: string;
  displayName: string;
  resourceCount: number;
  keywords: string[];
}

interface PatternDetail extends PatternListEntry {
  resources: Array<{
    resourceId: string;
    resourceType: string;
    displayName: string;
    provisionable: boolean;
  }>;
  dependencyOrder: string[][];
}

function toListEntry(p: ArchitecturePattern): PatternListEntry {
  return {
    patternId: p.patternId,
    displayName: p.displayName,
    resourceCount: p.resourceList.length,
    keywords: p.keywords,
  };
}

function toDetail(p: ArchitecturePattern): PatternDetail {
  return {
    ...toListEntry(p),
    resources: p.resourceList.map((r) => ({
      resourceId: r.resourceId,
      resourceType: r.resourceType,
      displayName: r.displayName,
      provisionable: r.provisionable !== false,
    })),
    dependencyOrder: p.dependencyOrder,
  };
}

export function renderPatternList(entries: PatternListEntry[]): string {
  if (entries.length === 0) return "No compound patterns registered.\n";
  const lines: string[] = [];
  lines.push(
    `${entries.length} compound pattern${entries.length === 1 ? "" : "s"} (in precedence order — first keyword match wins):`,
  );
  lines.push("");
  for (const entry of entries) {
    const preview = entry.keywords.slice(0, 3).join('", "');
    const more =
      entry.keywords.length > 3 ? ` +${entry.keywords.length - 3} more` : "";
    lines.push(
      `  ${entry.patternId}  — ${entry.displayName} (${entry.resourceCount} resources)`,
    );
    lines.push(`    keywords: "${preview}"${more}`);
    lines.push("");
  }
  lines.push(
    `Run 'assignee patterns show <patternId>' for the full resource list + dependency order.`,
  );
  return lines.join("\n") + "\n";
}

export function renderPatternDetail(detail: PatternDetail): string {
  const lines: string[] = [];
  lines.push(`${detail.patternId} — ${detail.displayName}`);
  lines.push("");
  lines.push(
    `Resources (${detail.resourceCount}${detail.resources.some((r) => !r.provisionable) ? `, ${detail.resources.filter((r) => !r.provisionable).length} display-only` : ""}):`,
  );
  for (const r of detail.resources) {
    const marker = r.provisionable ? "  " : "  ⚠ display-only: ";
    lines.push(`${marker}${r.resourceId} (${r.resourceType})`);
  }
  lines.push("");
  lines.push(`Dependency order (${detail.dependencyOrder.length} groups):`);
  for (let i = 0; i < detail.dependencyOrder.length; i++) {
    const group = detail.dependencyOrder[i]!;
    lines.push(`  ${i + 1}. ${group.join(", ")}`);
  }
  lines.push("");
  lines.push(`Keywords (${detail.keywords.length}):`);
  for (const kw of detail.keywords) {
    lines.push(`  "${kw}"`);
  }
  return lines.join("\n") + "\n";
}

export const patternsCommand = new Command("patterns").description(
  "List and inspect compound architecture patterns",
);

patternsCommand
  .command("list", { isDefault: true })
  .description("List all registered compound patterns")
  .option("--json", "Output as JSON")
  .action((opts: { json?: boolean }) => {
    const entries = defaultPatternRegistry.list().map(toListEntry);
    if (opts.json) {
      process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
      return;
    }
    process.stdout.write(renderPatternList(entries));
  });

patternsCommand
  .command("show <patternId>")
  .description(
    "Show the full resource list + dependency order + keywords for a pattern",
  )
  .option("--json", "Output as JSON")
  .action((patternId: string, opts: { json?: boolean }) => {
    const pattern = defaultPatternRegistry.get(patternId);
    if (!pattern) {
      const known = defaultPatternRegistry
        .list()
        .map((p) => p.patternId)
        .join(", ");
      process.stderr.write(
        `Unknown patternId "${patternId}". Known patterns: ${known}\n`,
      );
      process.exit(1);
    }
    const detail = toDetail(pattern);
    if (opts.json) {
      process.stdout.write(JSON.stringify(detail, null, 2) + "\n");
      return;
    }
    process.stdout.write(renderPatternDetail(detail));
  });
