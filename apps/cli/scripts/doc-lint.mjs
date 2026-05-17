#!/usr/bin/env node
/**
 * doc-lint.mjs — narrative-count drift guard for public docs.
 *
 * Extends the Story 54-it1-04 SSO work: the help-hints module derives
 * runtime hint strings from `SUPPORTED_TYPES_ARRAY` and
 * `defaultPatternRegistry` so terminal-surface drift is impossible.
 * This linter closes the remaining gap — the static narrative counts
 * in `README.md` and `docs/integration-architecture.md` that cannot be
 * rendered from a registry at build time.
 *
 * Guards four assertions (Story 56-it1-04, closes it56-1-L3-002;
 * cross-doc node/pattern guards added in docs-accuracy-sweep-2026-05-16):
 *
 *   1. `README.md` pattern-table row count must equal
 *      `defaultPatternRegistry.size()`. The table is located by
 *      scanning for the `| Pattern |` header between the
 *      "Compound architecture patterns" heading and the next `---`
 *      horizontal rule.
 *
 *   2. `docs/integration-architecture.md` narrative counts for
 *      "N user-addressable resource type", "N registered plugins",
 *      "N compound architecture patterns", "N strategies" and
 *      "N decomposers" must match the runtime registry values.
 *
 *   3. Cross-doc graphNodeCount guard: any doc in CROSS_DOC_TARGETS that
 *      claims "N-node pipeline/graph/agent", "with N nodes", "same N nodes",
 *      or "LangGraph Agent (N Nodes)" must match the runtime addNode() count
 *      from `packages/core/src/graph/create-graph.ts`. Catches the 14→15
 *      drift class that required a manual sweep in Epic-104.
 *
 *   4. Cross-doc patternCount guard: any doc claiming "N compound
 *      architecture patterns" must match defaultPatternRegistry.size().
 *
 * Exit codes:
 *   0 — every narrative count matches runtime.
 *   1 — drift detected; details printed to stderr.
 *   2 — fatal (unreadable file, missing registry import, etc.).
 *
 * Usage:
 *   pnpm doc-lint
 *
 * Dependencies: requires `packages/core/dist/` to be built (same
 * constraint as `scripts/check-mock-fixture-drift.mts`). Run
 * `pnpm build` first in a fresh checkout.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");

/**
 * Load runtime registry counts from the built `@assignee/core` dist.
 * Throws a friendly message if the dist is missing so CI surfaces the
 * actionable "run pnpm build" hint rather than a raw ESM resolve error.
 */
async function loadRuntimeCounts() {
  const coreDist = join(REPO_ROOT, "packages", "core", "dist", "index.js");
  let mod;
  try {
    mod = await import(coreDist);
  } catch (err) {
    throw new Error(
      `doc-lint: cannot import @assignee/core dist from ${coreDist}. ` +
        `Run \`pnpm build\` first. Underlying error: ${err?.message ?? err}`,
    );
  }
  const {
    SUPPORTED_TYPES_ARRAY,
    defaultPatternRegistry,
    defaultPricingRegistry,
  } = mod;
  if (!Array.isArray(SUPPORTED_TYPES_ARRAY)) {
    throw new Error("doc-lint: SUPPORTED_TYPES_ARRAY export missing");
  }
  if (!defaultPatternRegistry || typeof defaultPatternRegistry.size !== "function") {
    throw new Error("doc-lint: defaultPatternRegistry export missing");
  }
  if (
    !defaultPricingRegistry ||
    typeof defaultPricingRegistry.registeredTypes !== "function"
  ) {
    throw new Error("doc-lint: defaultPricingRegistry export missing");
  }
  const supportedTypeCount = SUPPORTED_TYPES_ARRAY.length;
  return {
    supportedTypeCount,
    patternCount: defaultPatternRegistry.size(),
    strategyCount: defaultPricingRegistry.registeredTypes().length,
    // Parity is enforced by `packages/core/src/pricing/decomposers/coverage.test.ts`
    // so the decomposer count always equals the supported-type count.
    // Walking the registry directly would require exposing a `.size()` /
    // `.list()` method that currently doesn't exist; the parity test is
    // the authoritative guard.
    decomposerCount: supportedTypeCount,
    // Command count: top-level CLI sub-commands wired via
    // `program.addCommand(...)` in `apps/cli/src/index.ts`. Excludes
    // hidden helpers (factories, formatters, filters).
    commandCount: await countCommands(),
    // Graph node count: `graph.addNode(...)` calls in
    // `packages/core/src/graph/create-graph.ts`. The 14 nodes are the
    // pipeline stages (intent-parser → schema-fetcher → … → result-formatter).
    graphNodeCount: await countGraphNodes(),
  };
}

/**
 * Count leaf CLI commands wired into the program tree.
 *
 * Story 108-A-05 round 2: tree-building moved from `apps/cli/src/index.ts`
 * into the shared factory `apps/cli/src/program.ts`. The factory wires
 * leaves under three noun groups (`infraGroup.addCommand(...)`,
 * `adminGroup.addCommand(...)`, `devGroup.addCommand(...)`), then attaches
 * each group to `program` via `program.addCommand(...)`.
 *
 * To report the LEAF count (the meaningful figure for the v1.0 freeze —
 * 18 user-facing commands), we count `<group>.addCommand(...)` in
 * `program.ts`, NOT `program.addCommand(...)` (which only yields the
 * three noun-group count).
 */
async function countCommands() {
  const programPath = join(
    REPO_ROOT,
    "apps",
    "cli",
    "src",
    "program.ts",
  );
  const text = await readFile(programPath, "utf8");
  const matches = text.match(/Group\.addCommand\s*\(/g);
  return matches ? matches.length : 0;
}

/** Count `.addNode(...)` calls in packages/core/src/graph/create-graph.ts. */
async function countGraphNodes() {
  const graphPath = join(
    REPO_ROOT,
    "packages",
    "core",
    "src",
    "graph",
    "create-graph.ts",
  );
  const text = await readFile(graphPath, "utf8");
  const matches = text.match(/\.addNode\s*\(/g);
  return matches ? matches.length : 0;
}

/**
 * Count rows in the README pattern table. Returns null if the table
 * cannot be located — caller surfaces a clear error in that case.
 *
 * The table is identified by the first `| Pattern |` header followed
 * by a divider row (`| :----…`), then data rows until a blank line or
 * heading boundary. This is resilient to small shifts in the line
 * numbering (README gets edited frequently).
 */
export function countReadmePatternRows(readmeText) {
  const lines = readmeText.split("\n");
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^\|\s*Pattern\s*\|/.test(l)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return null;
  // Expect divider row at headerIdx+1, data rows start at headerIdx+2.
  const divider = lines[headerIdx + 1] ?? "";
  if (!/^\|\s*[:-]+/.test(divider)) return null;
  let count = 0;
  for (let i = headerIdx + 2; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l || !l.trim().startsWith("|")) break;
    count += 1;
  }
  return count;
}

/**
 * Extract narrative counts from integration-architecture.md.
 *
 * Returns an object of {matcherLabel: extractedCount} for every
 * pattern the linter guards. A `null` extracted count means the
 * matcher didn't fire — treated as a drift error so future prose
 * rewrites can't silently escape the guard.
 */
export function extractIntegrationArchitectureCounts(docText) {
  const patterns = [
    {
      label: "user-addressable resource types",
      // "All 37 user-addressable resource type constants"
      re: /All\s+(\d+)\s+user-addressable\s+resource\s+type/i,
      expect: "supportedTypeCount",
    },
    {
      label: "registered plugins",
      // "Resource plugin registry (37 registered plugins:"
      re: /Resource plugin registry \((\d+)\s+registered plugins/i,
      expect: "supportedTypeCount",
    },
    {
      label: "compound architecture patterns",
      // "Pattern template registry (10 compound architecture patterns)"
      re: /Pattern template registry \((\d+)\s+compound architecture patterns\)/i,
      expect: "patternCount",
    },
    {
      label: "pricing strategies",
      // "Pricing strategy registry (23 strategies)"
      re: /Pricing strategy registry \((\d+)\s+strategies\)/i,
      expect: "strategyCount",
    },
    {
      label: "pricing decomposers",
      // "decomposer registry (23 decomposers)"
      re: /decomposer registry \((\d+)\s+decomposers\)/i,
      expect: "decomposerCount",
    },
  ];
  const results = [];
  for (const p of patterns) {
    const m = p.re.exec(docText);
    results.push({
      label: p.label,
      expect: p.expect,
      actual: m ? Number.parseInt(m[1], 10) : null,
    });
  }
  return results;
}

/**
 * Cross-doc count guards: a phrase like "37 supported types" must match
 * the runtime count regardless of which doc file it appears in. The
 * regex captures the count; the `expect` key resolves to a runtime
 * value. Each entry runs against the file glob list below.
 *
 * Adding a new doc to the glob is enough to make the guard apply to
 * it — keeping prose authors honest in every user-facing markdown
 * file. Engineering-flavoured snapshots (changelog-history.md) are
 * deliberately excluded because they record historical counts.
 */
/**
 * Patterns that clearly assert a GLOBAL count (not a test-scope subset
 * or a historical snapshot). The "all N" / "N user-addressable" /
 * "N first-class" / "N supported types" prefix discriminates a system-
 * wide claim from a per-test-file claim like
 * `"smoke-traces 6 compound patterns"`.
 */
const CROSS_DOC_GUARDS = [
  {
    label: "supported resource types",
    re: /\b(?:all|over|across)\s+(?:the\s+)?(\d+)\s+(?:supported\s+)?resource\s+types\b/gi,
    expect: "supportedTypeCount",
  },
  {
    label: "supported types (no `resource` keyword)",
    // Bug-hunt R4 G-1: testing-guide.md:485 reads "all 38 supported
    // types" (without `resource`); the prior regex required the
    // `resource` keyword and silently let drift slip past. The doc was
    // hand-edited 37→38 in cluster G; the guard must also match this
    // shape.
    re: /\b(?:all|over|across)\s+(?:the\s+)?(\d+)\s+supported\s+types\b/gi,
    expect: "supportedTypeCount",
  },
  {
    label: "first-class CCAPI types",
    re: /\b(\d+)\s+first-class\s+CCAPI\s+types\b/gi,
    expect: "supportedTypeCount",
  },
  {
    label: "user-addressable resource types",
    re: /\b(?:all\s+)?(\d+)\s+user-addressable\s+resource\s+types?\b/gi,
    expect: "supportedTypeCount",
  },
  {
    label: "registered plugins",
    re: /\b(?:all\s+)?(\d+)\s+registered\s+plugins?\b/gi,
    expect: "supportedTypeCount",
  },
  {
    label: "decomposers (registry total)",
    // QA Q-003: "38 decomposers" (or similar) needs a guard; previously
    // only the parenthetical "decomposer registry (N decomposers)"
    // shape was guarded.
    re: /\b(\d+)\s+decomposers\b/gi,
    expect: "decomposerCount",
  },
  {
    label: "compound patterns are exercised",
    // QA Q-003: "11 compound patterns are exercised end-to-end" — the
    // global "exercised" framing.
    re: /\b(\d+)\s+compound\s+patterns?\s+are\s+exercised\b/gi,
    expect: "patternCount",
  },
  {
    label: "first-class compound architecture patterns",
    // QA Q-003: "Pattern template registry (11 compound architecture
    // patterns)" or "11 first-class compound architecture patterns" —
    // global registry-size claim.
    re: /\b(\d+)\s+(?:first-class\s+)?compound\s+architecture\s+patterns\b/gi,
    expect: "patternCount",
  },
  {
    label: "user-addressable types (no `resource` keyword)",
    // QA Q-003: mcp-server.md:311 reads "the 38 user-addressable types"
    // — `resource` keyword absent, prior regex missed it.
    re: /\b(?:the\s+)?(\d+)\s+user-addressable\s+types\b/gi,
    expect: "supportedTypeCount",
  },
  {
    label: "BP rules + N compound patterns",
    // A claim like "the 185 BP rules + 11 compound patterns" — clearly
    // global, not a per-test-file subset.
    re: /BP\s+rules?\s*\+\s*(\d+)\s+compound\s+patterns?\b/gi,
    expect: "patternCount",
  },
  {
    label: "graph node count (N-node pipeline/graph/agent)",
    // Catches prose like "14-node LangGraph pipeline", "15-node pipeline",
    // "15-node graph", "LangGraph Agent (15 Nodes)". The advisory
    // <!-- doc-lint: node-count --> comment is a doc hint; this guard
    // enforces the claim regardless of the comment presence.
    re: /\b(\d+)-node\s+(?:LangGraph\s+)?(?:pipeline|graph|agent)\b/gi,
    expect: "graphNodeCount",
  },
  {
    label: "graph node count (StateGraph with N nodes / same N nodes / all N nodes)",
    // Catches prose like "StateGraph … with 15 nodes", "same 15 nodes",
    // "all 15 nodes", "declares 15 nodes".
    re: /\b(?:with|same|all|declares?)\s+(\d+)\s+nodes?\b/gi,
    expect: "graphNodeCount",
  },
  {
    label: "graph node count (N Nodes label)",
    // Catches mermaid subgraph labels like `LangGraph Agent (15 Nodes)`.
    re: /LangGraph\s+Agent\s+\((\d+)\s+Nodes?\)/gi,
    expect: "graphNodeCount",
  },
];

/**
 * Files that the cross-doc guards walk. Engineering snapshots like
 * `docs/engineering/changelog-history.md` are excluded — they record
 * point-in-time counts, not current state.
 */
const CROSS_DOC_TARGETS = [
  "docs/architecture.md",
  "docs/architecture-flows.md",
  "docs/integration-architecture.md",
  "docs/explanation/ai-architecture.md",
  "docs/explanation/oss-vs-saas.md",
  "docs/how-to/quickstart.md",
  "docs/testing-guide.md",
  "docs/index.md",
  "docs/mcp-server.md",
];

/**
 * Run every assertion. Exported so the test suite can feed drifted
 * temp fixtures in and assert the linter reports violations.
 */
export async function runDocLint({
  readmePath,
  integrationArchPath,
  runtimeCounts,
  repoRoot = REPO_ROOT,
  crossDocTargets = CROSS_DOC_TARGETS,
}) {
  const errors = [];
  const readmeText = await readFile(readmePath, "utf8");
  const rows = countReadmePatternRows(readmeText);
  if (rows === null) {
    errors.push(
      `README pattern-table header not found in ${readmePath}. ` +
        `Expected a \`| Pattern | ... |\` row.`,
    );
  } else if (rows !== runtimeCounts.patternCount) {
    errors.push(
      `README pattern-table has ${rows} rows but ` +
        `defaultPatternRegistry.size() === ${runtimeCounts.patternCount}. ` +
        `Update the table in ${readmePath} or re-register the missing pattern(s).`,
    );
  }

  const archText = await readFile(integrationArchPath, "utf8");
  const extracted = extractIntegrationArchitectureCounts(archText);
  for (const { label, expect, actual } of extracted) {
    const expected = runtimeCounts[expect];
    if (actual === null) {
      errors.push(
        `integration-architecture narrative for "${label}" not found in ${integrationArchPath}. ` +
          `The linter regex no longer matches — either the prose was rewritten ` +
          `(update the regex in doc-lint.mjs) or the count sentence was deleted.`,
      );
    } else if (actual !== expected) {
      errors.push(
        `integration-architecture narrative "${label}" says ${actual} but ` +
          `runtime registry reports ${expected}. ` +
          `Update ${integrationArchPath} or the registry.`,
      );
    }
  }

  // Cross-doc count guards: walk every drift-prone user-facing doc and
  // check that any narrative count of supported types / compound
  // patterns matches the runtime registry. Engineering-flavoured
  // history files are deliberately excluded via CROSS_DOC_TARGETS.
  for (const relPath of crossDocTargets) {
    const docPath = join(repoRoot, relPath);
    let text;
    try {
      text = await readFile(docPath, "utf8");
    } catch {
      continue; // Optional doc — skip if absent.
    }
    for (const guard of CROSS_DOC_GUARDS) {
      const expected = runtimeCounts[guard.expect];
      const matches = text.matchAll(guard.re);
      for (const m of matches) {
        const actual = Number.parseInt(m[1], 10);
        if (Number.isFinite(actual) && actual !== expected) {
          errors.push(
            `${relPath}: narrative says "${m[0]}" but runtime ${guard.label} count is ${expected}. ` +
              `Update the doc or the registry.`,
          );
        }
      }
    }
  }

  return errors;
}

async function main() {
  const runtimeCounts = await loadRuntimeCounts();
  const errors = await runDocLint({
    readmePath: join(REPO_ROOT, "README.md"),
    integrationArchPath: join(REPO_ROOT, "docs", "integration-architecture.md"),
    runtimeCounts,
  });
  process.stdout.write(
    `doc-lint: patterns=${runtimeCounts.patternCount} ` +
      `types=${runtimeCounts.supportedTypeCount} ` +
      `strategies=${runtimeCounts.strategyCount} ` +
      `decomposers=${runtimeCounts.decomposerCount} ` +
      `commands=${runtimeCounts.commandCount} ` +
      `graphNodes=${runtimeCounts.graphNodeCount}\n`,
  );
  if (errors.length > 0) {
    for (const e of errors) {
      process.stderr.write(`DRIFT  ${e}\n`);
    }
    process.exit(1);
  }
}

// Only run main() when invoked as a script. The module is also imported
// by `apps/cli/src/__tests__/doc-lint.test.ts` which calls the exported
// helpers directly against temp fixtures.
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("doc-lint.mjs");
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`doc-lint: fatal: ${err?.stack ?? err}\n`);
    process.exit(2);
  });
}
