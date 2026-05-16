/**
 * `assignee discover` command — interactive catalogue picker (Story 108-A-03).
 *
 * Provides first-run discoverability for the 38 supported resource types,
 * 13 compound patterns, and 18 CLI commands via a fuzzy-search picker in
 * TTY contexts, a paged plain-text list in non-TTY/pipe contexts, and a
 * structured JSON catalogue via `--json`.
 *
 * ## Output modes
 *
 * TTY (interactive):
 *   `@clack/prompts` `autocomplete` provides a type-ahead search picker
 *   grouped by category. On selection, the command prints the selected
 *   item's description and a sample `assignee plan` invocation.
 *
 * Non-TTY (pipe / CI):
 *   Writes a paged plain-text list to stdout with category headers
 *   (## Resource Types / ## Patterns / ## Commands). No ANSI codes.
 *
 * `--json` (machine-readable):
 *   Writes a JSON array of `{ id, category, description, exampleIntent }`
 *   objects covering every catalogue item.
 *
 * ## Flag registration
 *
 * `--json` and `--category` are added to `PROBE_WHITELIST_FLAGS` in
 * `packages/core/src/__tests__/shipped-wired-contract.test.ts` because:
 *   - `--json` is already in the whitelist (global).
 *   - `--category` is covered by unit tests in `discover.test.ts` (Axes G/H/I).
 *
 * ## Library choice
 *
 * `@clack/prompts` (already in `apps/cli/package.json`). The `autocomplete`
 * API provides built-in type-ahead filtering with a custom `filter` hook.
 * This avoids adding a new dependency (vs `inquirer`), aligns with the
 * existing usage in `init.ts` / `setup.ts`, and the modular import tree
 * keeps the CLI startup overhead minimal.
 *
 * Story 108-A-03.
 */

import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";
import { isCancel, autocomplete, note, outro, cancel } from "@clack/prompts";
import {
  buildCatalogue,
  type DiscoverCategory,
  type CatalogueItem,
} from "./discover-data.js";

// ---------------------------------------------------------------------------
// CLI flag validation
// ---------------------------------------------------------------------------

const VALID_CATEGORIES: readonly DiscoverCategory[] = [
  "resource-types",
  "patterns",
  "commands",
];

function parseCategoryFlag(raw: string): DiscoverCategory {
  const normalized = raw.toLowerCase() as DiscoverCategory;
  if (!VALID_CATEGORIES.includes(normalized)) {
    throw new InvalidArgumentError(
      `--category must be one of: ${VALID_CATEGORIES.join(" | ")} (got "${raw}")`,
    );
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Non-TTY plain-text output
// ---------------------------------------------------------------------------

/**
 * Strip all ANSI escape codes from a string.
 * Used to ensure non-TTY output is clean for piping.
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Emit a paged plain-text catalogue listing.
 * No ANSI escape codes — safe for piping to `cat`, `grep`, etc.
 *
 * Output format:
 *   ## Resource Types
 *   AWS::S3::Bucket  S3 object-storage bucket
 *     Example: assignee plan "Create a Bucket"
 *   ...
 *   ## Patterns
 *   ...
 *   ## Commands
 *   ...
 */
function renderPlainTextList(items: CatalogueItem[]): string {
  const lines: string[] = [];

  const categories: Array<{ label: string; key: DiscoverCategory }> = [
    { label: "Resource Types", key: "resource-types" },
    { label: "Patterns", key: "patterns" },
    { label: "Commands", key: "commands" },
  ];

  for (const { label, key } of categories) {
    const catItems = items.filter((item) => item.category === key);
    if (catItems.length === 0) continue;

    lines.push(`## ${label}`);
    lines.push("");

    for (const item of catItems) {
      lines.push(`${item.id}`);
      lines.push(`  ${item.description}`);
      lines.push(`  Example: ${item.exampleIntent}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

function renderJson(items: CatalogueItem[]): string {
  return JSON.stringify(items, null, 2);
}

// ---------------------------------------------------------------------------
// TTY interactive mode
// ---------------------------------------------------------------------------

/**
 * Run the interactive `@clack/prompts` autocomplete picker.
 *
 * The picker is grouped visually but backed by a flat list — clack's
 * `autocomplete` handles the type-ahead filtering via the `filter` hook.
 * On selection, the command prints a detail block with description +
 * sample invocation.
 */
async function runInteractivePicker(items: CatalogueItem[]): Promise<void> {
  // Group label for each autocomplete option (shown as hint)
  const categoryLabel: Record<DiscoverCategory, string> = {
    "resource-types": "Resource Type",
    patterns: "Pattern",
    commands: "Command",
  };

  const options = items.map((item) => ({
    value: item,
    label: item.id,
    hint: `[${categoryLabel[item.category]}] ${item.description}`,
  }));

  const result = await autocomplete({
    message: "Search resource types, patterns, and commands (type to filter)",
    options,
    filter: (search, option) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      const item = option.value as CatalogueItem;
      return (
        item.id.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
      );
    },
  });

  if (isCancel(result)) {
    cancel("Discovery cancelled.");
    return;
  }

  const selected = result as CatalogueItem;

  // Display the selection detail block
  note(
    [
      chalk.bold(selected.id),
      chalk.gray(`Category:    ${selected.category}`),
      chalk.gray(`Description: ${selected.description}`),
      "",
      chalk.cyan("Example:"),
      `  ${selected.exampleIntent}`,
    ].join("\n"),
    "Selected",
  );

  outro(chalk.gray("Run the example above to get started."));
}

// ---------------------------------------------------------------------------
// Command options interface
// ---------------------------------------------------------------------------

interface DiscoverOptions {
  json?: boolean;
  category?: DiscoverCategory;
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

export const discoverCommand = new Command("discover")
  .description(
    "Browse and search all supported resource types, compound patterns, and CLI commands",
  )
  .option("--json", "Output the full catalogue as a JSON array")
  .option(
    "--category <filter>",
    "Filter by category: resource-types | patterns | commands",
    parseCategoryFlag,
  )
  .addHelpText(
    "after",
    `
Output modes:
  TTY (default)    Interactive fuzzy picker — type to search, Enter to select.
  Pipe / non-TTY   Plain-text paged list with category headers; no ANSI codes.
                   Example: assignee discover | grep s3
  --json           Machine-readable JSON array for scripting/tooling.
                   Each item: { id, category, description, exampleIntent }

Flags:
  --json           Emit JSON regardless of TTY state.
  --category       Restrict output to one category:
                     resource-types  — AWS::* CloudFormation resource types
                     patterns        — multi-resource architecture patterns
                     commands        — CLI subcommands

Examples:
  $ assignee discover
        Interactive picker in a terminal
  $ assignee discover | cat
        Paged plain-text list (pipe-friendly)
  $ assignee discover --json
        Full catalogue as JSON
  $ assignee discover --category resource-types
        Resource types only (interactive if TTY, plain-text if not)
  $ assignee discover --json | jq '[.[] | select(.category == "patterns")]'
        Filter patterns in JSON mode via jq
`,
  )
  .action(async (opts: DiscoverOptions) => {
    const category = opts.category;
    const items = buildCatalogue(category);

    // --json mode: always emit structured JSON regardless of TTY
    if (opts.json) {
      process.stdout.write(renderJson(items) + "\n");
      return;
    }

    // Non-TTY mode: paged plain-text (no ANSI)
    if (process.stdout.isTTY !== true) {
      const output = stripAnsi(renderPlainTextList(items));
      process.stdout.write(output);
      return;
    }

    // TTY interactive mode
    await runInteractivePicker(items);
  });
