/**
 * `assignee types` command — discover the CloudFormation resource
 * types assignee can provision directly.
 *
 * Subcommands:
 *   - `assignee types list` (default): print every supported type
 *     with its short name, plugin field count, and the number of
 *     BP rules that target it.
 *   - `assignee types show <type>`: print the plugin's common +
 *     advanced fields, applicable BP rules, and pricing strategy
 *     info for a single type.
 *
 * Both subcommands support `--json`.
 *
 * Companion to `assignee patterns` — patterns are the compound
 * routing layer, types are the atomic provisioning unit. A user
 * exploring "can assignee create an X?" should find their answer
 * in one of the two listings.
 */

import { Command } from "commander";
import { resolve } from "node:path";
import {
  SUPPORTED_TYPES_ARRAY,
  defaultPluginRegistry,
  defaultPricingRegistry,
  defaultPatternRegistry,
  RESOURCE_IDENTIFIER_KEYS,
  type ResourceType,
} from "@assignee/core";
import { loadBestPractices } from "@assignee/best-practices";

interface TypeListEntry {
  resourceType: string;
  shortName: string;
  commonFieldCount: number;
  advancedFieldCount: number;
  bpRuleCount: number;
}

interface TypeDetail extends TypeListEntry {
  commonFields: Array<{ name: string; required: boolean }>;
  advancedFields: Array<{ name: string; required: boolean }>;
  bpRules: Array<{ id: string; severity: string; title: string }>;
  hasPricingStrategy: boolean;
  usedByPatterns: Array<{ patternId: string; displayName: string }>;
  primaryIdentifier: string;
}

/**
 * Reverse lookup: which compound patterns include a given resource
 * type? Walks every registered pattern's resourceList looking for a
 * resourceType match. Returns in registration order.
 */
function patternsContaining(
  resourceType: string,
): Array<{ patternId: string; displayName: string }> {
  return defaultPatternRegistry
    .list()
    .filter((p) => p.resourceList.some((r) => r.resourceType === resourceType))
    .map((p) => ({ patternId: p.patternId, displayName: p.displayName }));
}

function shortName(resourceType: string): string {
  // "AWS::EC2::Instance" → "EC2 Instance"
  const parts = resourceType.split("::");
  if (parts.length !== 3) return resourceType;
  return `${parts[1]} ${parts[2]}`;
}

function bpRulesForType(
  resourceType: string,
  practices: Array<{
    id: string;
    severity: string;
    title: string;
    resource_type: string;
  }>,
): Array<{ id: string; severity: string; title: string }> {
  return practices
    .filter((p) => p.resource_type === resourceType)
    .map((p) => ({ id: p.id, severity: p.severity, title: p.title }));
}

function loadPractices(): ReturnType<typeof loadBestPractices> {
  // Walk up from the built CLI file's location to the monorepo root and
  // find the best-practices package. Same logic as doctor.ts.
  const bpDir = resolve(
    import.meta.dirname,
    "../../../../packages/best-practices",
  );
  try {
    return loadBestPractices(bpDir);
  } catch {
    return [];
  }
}

export function renderTypeList(entries: TypeListEntry[]): string {
  if (entries.length === 0) return "No supported resource types.\n";
  const lines: string[] = [];
  lines.push(
    `${entries.length} supported resource type${entries.length === 1 ? "" : "s"}:`,
  );
  lines.push("");
  for (const entry of entries) {
    lines.push(
      `  ${entry.resourceType}  (${entry.commonFieldCount}+${entry.advancedFieldCount} fields, ${entry.bpRuleCount} BP rules)`,
    );
  }
  lines.push("");
  lines.push(
    `Run 'assignee types show <type>' for the full field + BP rule listing.`,
  );
  return lines.join("\n") + "\n";
}

export function renderTypeDetail(detail: TypeDetail): string {
  const lines: string[] = [];
  lines.push(`${detail.resourceType} — ${detail.shortName}`);
  lines.push("");
  lines.push(`Common fields (${detail.commonFields.length}):`);
  for (const f of detail.commonFields) {
    lines.push(`  ${f.required ? "* " : "  "}${f.name}`);
  }
  if (detail.advancedFields.length > 0) {
    lines.push("");
    lines.push(`Advanced fields (${detail.advancedFields.length}):`);
    for (const f of detail.advancedFields) {
      lines.push(`  ${f.required ? "* " : "  "}${f.name}`);
    }
  }
  lines.push("");
  lines.push(`Primary identifier: ${detail.primaryIdentifier}`);
  lines.push(
    `Pricing strategy: ${detail.hasPricingStrategy ? "registered" : "none"}`,
  );
  lines.push("");
  lines.push(`Best practice rules (${detail.bpRules.length}):`);
  if (detail.bpRules.length === 0) {
    lines.push("  (none — this type has no BP coverage yet)");
  } else {
    for (const rule of detail.bpRules) {
      lines.push(`  [${rule.severity}] ${rule.id} — ${rule.title}`);
    }
  }
  lines.push("");
  lines.push(`Used by compound patterns (${detail.usedByPatterns.length}):`);
  if (detail.usedByPatterns.length === 0) {
    lines.push(
      "  (none — this type is only provisioned directly, not as part of any compound)",
    );
  } else {
    for (const pattern of detail.usedByPatterns) {
      lines.push(`  ${pattern.patternId} — ${pattern.displayName}`);
    }
  }
  return lines.join("\n") + "\n";
}

export const typesCommand = new Command("types").description(
  "List and inspect the CloudFormation resource types assignee can provision",
);

typesCommand
  .command("list", { isDefault: true })
  .description(
    "List every supported resource type with its field + BP rule count",
  )
  .option("--json", "Output as JSON")
  .option(
    "--search <keyword>",
    "Filter types whose resourceType or short name contains the substring (case-insensitive)",
  )
  .action((opts: { json?: boolean; search?: string }) => {
    const practices = loadPractices();
    let entries: TypeListEntry[] = SUPPORTED_TYPES_ARRAY.map((resourceType) => {
      const plugin = defaultPluginRegistry.get(resourceType);
      return {
        resourceType,
        shortName: shortName(resourceType),
        commonFieldCount: plugin?.commonFields.length ?? 0,
        advancedFieldCount: plugin?.advancedFields.length ?? 0,
        bpRuleCount: bpRulesForType(resourceType, practices).length,
      };
    });
    if (opts.search) {
      const needle = opts.search.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.resourceType.toLowerCase().includes(needle) ||
          e.shortName.toLowerCase().includes(needle),
      );
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
      return;
    }
    process.stdout.write(renderTypeList(entries));
  });

typesCommand
  .command("show <type>")
  .description(
    "Show the full plugin field list + BP rules + pricing info for a resource type",
  )
  .option("--json", "Output as JSON")
  .action((resourceType: string, opts: { json?: boolean }) => {
    if (!SUPPORTED_TYPES_ARRAY.includes(resourceType as never)) {
      process.stderr.write(
        `Unknown resource type "${resourceType}". Run 'assignee types list' to see the full list.\n`,
      );
      process.exit(1);
    }
    const plugin = defaultPluginRegistry.get(resourceType);
    const practices = loadPractices();
    const detail: TypeDetail = {
      resourceType,
      shortName: shortName(resourceType),
      commonFieldCount: plugin?.commonFields.length ?? 0,
      advancedFieldCount: plugin?.advancedFields.length ?? 0,
      bpRuleCount: bpRulesForType(resourceType, practices).length,
      commonFields: (plugin?.commonFields ?? []).map((f) => ({
        name: f.name,
        required: f.required === true,
      })),
      advancedFields: (plugin?.advancedFields ?? []).map((f) => ({
        name: f.name,
        required: f.required === true,
      })),
      bpRules: bpRulesForType(resourceType, practices),
      hasPricingStrategy: defaultPricingRegistry.has(resourceType),
      usedByPatterns: patternsContaining(resourceType),
      primaryIdentifier:
        RESOURCE_IDENTIFIER_KEYS[resourceType as ResourceType] ?? "(unknown)",
    };
    if (opts.json) {
      process.stdout.write(JSON.stringify(detail, null, 2) + "\n");
      return;
    }
    process.stdout.write(renderTypeDetail(detail));
  });
