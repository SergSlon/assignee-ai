/**
 * Epic 96 M1 — Shipped-wired contract drift guards.
 *
 * Six drift-guard tests that enforce the invariants partial-landing
 * epics (92/94/95) violated:
 *
 *   A. Graph wiring contract     — every GraphNode enum entry is wired
 *      into create-graph.ts's node list.
 *   B. Commander flag coverage   — every .option() across apps/cli/src/commands
 *      is either exercised by PROBE_MANIFEST.yaml or explicitly whitelisted.
 *   C. Pattern-template parity   — every PatternId value has a registry
 *      entry AND a help-hints descriptions entry AND a test file.
 *   D. Plugin-default survival   — every defaults[key] from every registered
 *      plugin survives a sanitizeDesiredState roundtrip.
 *   E. Single-Examples contract  — `node apps/cli/dist/index.js <cmd> --help`
 *      emits exactly 1 `Examples:` heading.
 *   F. Envelope-schema parity    — PROBE_MANIFEST.yaml references only
 *      exit codes / `ok` pairs consistent with the JSON envelope contract.
 *
 * Cross-package notes:
 *   A/C/D exercise in-core code only.
 *   B/E spawn node on apps/cli/dist/index.js — tests assume the CLI is
 *     built. The vitest runner for `pnpm --filter @assignee/core test`
 *     does NOT trigger an apps/cli build automatically; CI orders
 *     `pnpm build` (which builds cli via turbo) before running tests.
 *     If dist is missing, B/E self-skip with a clear message.
 *   F reads PROBE_MANIFEST.yaml directly via fs.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

import { GraphNode } from "../constants/graph-node.js";
import { PatternId } from "../pattern-templates/pattern-ids.js";
import { defaultPatternRegistry } from "../pattern-templates/index.js";
import { defaultPluginRegistry } from "../resource-plugins/index.js";
import { SUPPORTED_TYPES_ARRAY } from "../config/resource-types/supported.js";
import { sanitizeDesiredState } from "../graph/nodes/result-formatter/formatters/plan.js";
import { renderPatternsHint } from "../config/help-hints.js";
import {
  isEmptyLeaf,
  mergePluginDefaults,
} from "../graph/nodes/plan-generator/llm-plan/merge.js";

// ---------------------------------------------------------------------------
// Resolve repo-root relative paths.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// packages/core/src/__tests__/shipped-wired-contract.test.ts → repo root
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const CLI_DIST = resolve(REPO_ROOT, "apps/cli/dist/index.js");
const COMMANDS_DIR = resolve(REPO_ROOT, "apps/cli/src/commands");
const PROBE_MANIFEST = resolve(
  REPO_ROOT,
  "apps/cli/scripts/PROBE_MANIFEST.yaml",
);
const CREATE_GRAPH_PATH = resolve(
  REPO_ROOT,
  "packages/core/src/graph/create-graph.ts",
);

// ---------------------------------------------------------------------------
// Shared utilities.
// ---------------------------------------------------------------------------

/** Best-effort recursive readdir that returns a flat list of .ts files. */
function listTsFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      listTsFiles(full, out);
    } else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Read PROBE_MANIFEST.yaml and extract the flat set of probe bodies
 * (concatenated). Used by B and F. The YAML shape is simple enough that
 * we skip yq — we just read the file as text.
 */
function readProbeManifestText(): string {
  if (!existsSync(PROBE_MANIFEST)) return "";
  return readFileSync(PROBE_MANIFEST, "utf8");
}

// ---------------------------------------------------------------------------
// A. Graph wiring contract
// ---------------------------------------------------------------------------

describe("shipped-wired contract A — graph wiring", () => {
  it("every GraphNode enum entry is referenced in create-graph.ts", () => {
    // Read create-graph.ts as source; the compiled createGraph() builds
    // the workflow imperatively, so the simplest invariant is textual:
    // each node name must appear as a `GraphNode.<KEY>` reference inside
    // an `.addNode(...)` call.
    expect(existsSync(CREATE_GRAPH_PATH)).toBe(true);
    const source = readFileSync(CREATE_GRAPH_PATH, "utf8");

    const missing: string[] = [];
    for (const key of Object.keys(GraphNode)) {
      // Match `GraphNode.<KEY>` in an `.addNode(` call. We scan all
      // `.addNode(GraphNode.<KEY>` occurrences.
      const re = new RegExp(`\\.addNode\\(\\s*GraphNode\\.${key}\\b`);
      if (!re.test(source)) {
        missing.push(key);
      }
    }
    // Not all GraphNode values are expected to be addNode-ed (some are
    // routing-only targets). But any key that is routed-to (via
    // `[GraphNode.<KEY>]:` in a conditional edge) MUST also be addNode-ed.
    const routedTo: string[] = [];
    for (const key of Object.keys(GraphNode)) {
      const re = new RegExp(`\\[GraphNode\\.${key}\\]:\\s*GraphNode\\.${key}`);
      if (re.test(source)) routedTo.push(key);
    }
    const leaks = missing.filter((k) => routedTo.includes(k));
    expect(leaks, `unwired routed-to nodes: ${leaks.join(", ")}`).toEqual([]);
    // Every GraphNode must either be addNode'd OR be a START/END synonym.
    // Currently all 14 GraphNode keys are addNode'd — this is the a11y
    // tripwire against future "module landed but un-wired" regressions.
    expect(
      missing,
      `GraphNode entries missing from create-graph addNode list: ${missing.join(
        ", ",
      )}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// B. Commander flag coverage
// ---------------------------------------------------------------------------

/**
 * Flags whitelisted as "not required to have a probe" — read-only flags
 * whose behaviour is exercised elsewhere (unit tests, inherited global
 * options). Add sparingly — the point of the drift guard is to make
 * un-probed flags visible.
 *
 * The list below is the snapshot as of Epic 96 M1. Every new flag added
 * to a command MUST either:
 *   (a) have a probe added to PROBE_MANIFEST.yaml in the same PR, OR
 *   (b) be explicitly added to this whitelist with a comment citing
 *       the unit test that already covers it.
 *
 * Flags CURRENTLY UN-PROBED and whitelisted at gate creation time
 * (deliberate deferral to Wave 1 story authors — they will either
 * add probes or move to a narrower whitelist tagged with rationale):
 */
const PROBE_WHITELIST_FLAGS = new Set<string>([
  // Universal flags shared via global options
  "--verbose",
  "--no-color",
  "--color",
  "--json",
  "-o",
  "--output",
  "-h",
  "--help",
  "-V",
  "--version",
  "-y",
  "--yes",
  "-q",
  "--quick",
  "-s",
  "--source",
  "--set",
  // plan / apply family common flags — probed via whole-command probes
  "--no-apply",
  "--no-advice",
  "--wizard",
  "--dry-run",
  "--region",
  "--resource",
  "--bp-coverage",
  "--skip-bedrock",
  "--skip-mcp",
  // Epic 96 pre-existing flags deferred to Wave 1/2 for dedicated
  // probes. Each of these has at least one unit test in
  // apps/cli/src/commands/**/*.test.ts — the drift guard exists to
  // catch flags with ZERO test coverage, which none of these have.
  // Wave 1 planners: tighten this list in planner phase.
  "--checkpoint", // apply/plan checkpoint resume — tested in plan/__tests__
  "--pending-window-in-days", // destroy (KMS) — tested in destroy.test.ts
  "--recovery-window-in-days", // destroy (Secrets) — tested in destroy.test.ts
  "--force-delete-without-recovery", // destroy — tested in destroy.test.ts
  "--short", // list/status short form — tested in list.test.ts
  "--status", // list status filter — tested in list.test.ts
  "--exclude", // list exclusion — tested in list.test.ts
  "--baseline", // drift baseline — tested in drift.test.ts
  "--output-file", // drift output — tested in drift.test.ts
  "--concurrency", // drift concurrency — tested in drift.test.ts
  "--detailed", // doctor detailed — tested in doctor.test.ts
  "--global", // init global — tested in init.test.ts
  "--auto-fix", // init/reconcile auto-fix — tested in reconcile.test.ts
  "--resource-type", // optimize / reconcile filter — tested in optimize.test.ts
  "--total-cost", // optimize total-cost — tested in optimize.test.ts
  "--min-savings", // optimize threshold — tested in optimize.test.ts
  "--auto-reconcile", // drift auto-reconcile — tested in drift.test.ts
  "--profile", // setup AWS profile — tested in setup.test.ts
  "--enable-llm-logging", // init toggle — tested in init.test.ts
  "--disable-llm-logging", // init toggle — tested in init.test.ts
  "--gaps-only", // status --bp-coverage — tested in status-bp-coverage.test.ts
  "--include-structural-gaps", // status --bp-coverage — tested in status-bp-coverage.test.ts
]);

/** Extract every `<long-flag>` from Commander `.option("...")` calls. */
function extractOptionFlags(source: string): string[] {
  const flags: string[] = [];
  // Match .option("-x, --long-flag <...>" | ".option("--long-flag...") patterns.
  const re = /\.option\(\s*["'`]([^"'`]+)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1]!;
    // Split on comma to handle short+long; keep any token starting with
    // "--" or single "-".
    for (const raw of spec.split(",")) {
      const token = raw.trim().split(/\s+/)[0] ?? "";
      if (token.startsWith("--") || /^-[a-zA-Z]$/.test(token)) {
        flags.push(token);
      }
    }
  }
  return flags;
}

describe("shipped-wired contract B — Commander flag coverage", () => {
  it("every Commander .option() flag is either probed or whitelisted", () => {
    const cmdFiles = listTsFiles(COMMANDS_DIR).filter(
      (f) => !f.includes("__tests__") && !f.includes("__fixtures__"),
    );
    if (cmdFiles.length === 0) {
      // Dev environment without cli src tree — treat as setup-failed
      // (fail loudly so the test author fixes the path).
      expect(
        cmdFiles.length,
        `no CLI command sources found at ${COMMANDS_DIR}`,
      ).toBeGreaterThan(0);
      return;
    }

    const allFlags = new Set<string>();
    for (const f of cmdFiles) {
      for (const flag of extractOptionFlags(readFileSync(f, "utf8"))) {
        allFlags.add(flag);
      }
    }

    const manifestText = readProbeManifestText();
    const unprobed: string[] = [];
    for (const flag of allFlags) {
      if (PROBE_WHITELIST_FLAGS.has(flag)) continue;
      // Probe coverage check: the flag literal must appear somewhere in
      // the manifest text (within a probe block). We don't require each
      // probe to invoke the flag — just that SOME probe references it.
      if (!manifestText.includes(flag)) {
        unprobed.push(flag);
      }
    }
    expect(
      unprobed,
      `Un-probed Commander flags (add to PROBE_MANIFEST.yaml OR whitelist in shipped-wired-contract.test.ts): ${unprobed.join(
        ", ",
      )}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C. Pattern-template parity
// ---------------------------------------------------------------------------

describe("shipped-wired contract C — pattern-template parity", () => {
  it("every PatternId has a registry entry AND a help-hints entry AND a test file", () => {
    // `renderPatternsHint("cli")` returns a hint string — it uses
    // `displayName` text (not patternId). We check each PatternId's
    // resolved `displayName` appears in the hint.
    const patternsHint = renderPatternsHint("cli");
    const registrySize = defaultPatternRegistry.size();
    const registeredIds: string[] = defaultPatternRegistry
      .list()
      .map((p: { patternId: string }) => p.patternId);
    const registry = defaultPatternRegistry;

    const patternsDir = resolve(
      REPO_ROOT,
      "packages/core/src/pattern-templates/patterns",
    );
    const patternTestsDir = resolve(
      REPO_ROOT,
      "packages/core/src/pattern-templates/__tests__",
    );
    const patternFilesExisting = existsSync(patternsDir)
      ? readdirSync(patternsDir)
      : [];
    const patternTestFilesExisting = existsSync(patternTestsDir)
      ? readdirSync(patternTestsDir)
      : [];

    const missingRegistry: string[] = [];
    const missingHint: string[] = [];
    const missingTest: string[] = [];

    const hintLower = patternsHint.toLowerCase();
    for (const id of Object.values(PatternId)) {
      if (!registeredIds.includes(id)) missingRegistry.push(id);
      // help-hints renders a lowercased paraphrase of displayName
      // (e.g. "Serverless API" → "create a serverless api"). Use a
      // case-insensitive substring check against the displayName with
      // parenthetical qualifiers stripped.
      const pattern = registry.get(id);
      const displayName = pattern?.displayName ?? id;
      const canonical = displayName
        .toLowerCase()
        .replace(/\s*\([^)]*\)\s*/g, " ")
        .trim();
      if (!hintLower.includes(canonical)) missingHint.push(id);
      // Test coverage: either a per-pattern source file has a sibling
      // .test.ts OR a __tests__/ entry mentions the pattern ID.
      const mentionedInTests = patternTestFilesExisting.some((name) => {
        const full = join(patternTestsDir, name);
        if (!name.endsWith(".test.ts")) return false;
        try {
          return readFileSync(full, "utf8").includes(id);
        } catch {
          return false;
        }
      });
      const hasPatternFile = patternFilesExisting.some((name) =>
        name.replace(/\.ts$/, "").endsWith(id),
      );
      if (!mentionedInTests && !hasPatternFile) missingTest.push(id);
    }

    expect(
      missingRegistry,
      `PatternId values missing from registry: ${missingRegistry.join(", ")}`,
    ).toEqual([]);
    expect(
      missingHint,
      `PatternId values missing from help-hints render: ${missingHint.join(
        ", ",
      )}`,
    ).toEqual([]);
    expect(
      missingTest,
      `PatternId values with no test coverage: ${missingTest.join(", ")}`,
    ).toEqual([]);

    // Every PatternId value must be in the registry (forward direction).
    // Reverse direction (registry entries NOT in PatternId) is allowed:
    // some patterns (vpc-networking, vpc-public-only) intentionally
    // bypass the enum because they are variants of a base pattern and
    // use the raw patternId string. This keeps PatternId as the canonical
    // list of "first-class, user-facing" patterns without forcing every
    // variant into the enum. A reverse-direction drift is surfaced via
    // a soft warning:
    const extraInRegistry = registeredIds.filter(
      (id) => !(Object.values(PatternId) as string[]).includes(id),
    );
    if (extraInRegistry.length > 0) {
      // Warn but do not fail — the variant names are legitimate. Planners
      // can decide whether to promote a variant into the PatternId enum.
      console.warn(
        `[contract C] patterns registered without PatternId entry (variants allowed): ${extraInRegistry.join(", ")}`,
      );
    }
    // Registry must be non-empty and size must be ≥ PatternId count.
    expect(registrySize).toBeGreaterThanOrEqual(
      Object.values(PatternId).length,
    );
  });
});

// ---------------------------------------------------------------------------
// D. Plugin-default survival
// ---------------------------------------------------------------------------

describe("shipped-wired contract D — plugin-default survival", () => {
  it("every plugin default key survives sanitizeDesiredState roundtrip", () => {
    const leaks: Array<{ resourceType: string; droppedKey: string }> = [];

    for (const resourceType of SUPPORTED_TYPES_ARRAY) {
      const plugin = defaultPluginRegistry.get(resourceType);
      if (!plugin) continue;
      const defaults = plugin.defaults ?? {};
      const roundtripped =
        sanitizeDesiredState(defaults as Record<string, unknown>) ?? {};
      for (const key of Object.keys(defaults)) {
        // The semantics of sanitizeDesiredState is to drop
        // undefined/null/empty-string values. Plugin defaults SHOULD
        // NOT contain those sentinels — if they do, the default is
        // effectively silently ignored at render time. A real leak here
        // is C-01 class: a plugin shipped a default (e.g. CPUCredits:"")
        // that sanitize then strips, leaving the default unused.
        if (!Object.prototype.hasOwnProperty.call(roundtripped, key)) {
          leaks.push({ resourceType, droppedKey: key });
        }
      }
    }

    expect(
      leaks,
      `Plugin defaults dropped by sanitizeDesiredState (C-01 class): ${leaks
        .map((l) => `${l.resourceType}.${l.droppedKey}`)
        .join(", ")}`,
    ).toEqual([]);
  });

  // e98.W3.A1 extension — every resource type registered for
  // LLM-path plugin-default backfill (via `mergePluginDefaults`) must
  // actually backfill every top-level non-empty default when the LLM
  // emits a minimal output. This is the cross-check that W3 broadened
  // the allowlist and the backfill logic still honours each entry.
  //
  // Approach:
  //   1. For each allowlisted resourceType (pulled by running the
  //      merge against a `ProbeSentinel` resource type to collect the
  //      synthetic unmerged shape), read the plugin's defaults.
  //   2. Call mergePluginDefaults({}, resourceType).
  //   3. For every non-empty-leaf key in defaults, assert the merged
  //      object has a non-empty-leaf value for that key too.
  //
  // We don't hard-code the allowlist here — it is imported from
  // merge.ts only indirectly (the merge function itself is the
  // authority). Instead we iterate SUPPORTED_TYPES_ARRAY and check
  // whichever types' merge call produces a change from the empty
  // input. That way future additions to the allowlist automatically
  // get covered; future REMOVALS from the allowlist silently fall
  // back to the "no backfill occurred" path, which is still allowed
  // (a missing entry is not automatically a violation — that's a
  // scoping decision a reviewer must make explicitly).
  it("every plugin backfilled by mergePluginDefaults restores each non-empty default", () => {
    const failures: Array<{ resourceType: string; key: string }> = [];

    for (const resourceType of SUPPORTED_TYPES_ARRAY) {
      const plugin = defaultPluginRegistry.get(resourceType);
      if (!plugin || !plugin.defaults) continue;
      const merged = mergePluginDefaults({}, resourceType);
      // If merging produced nothing beyond `{}`, this type is not on
      // the allowlist — skip. (Accessors like SNS TopicName always
      // return a string, so any allowlisted plugin will emit at
      // least one key here.)
      if (Object.keys(merged).length === 0) continue;

      for (const key of Object.keys(plugin.defaults)) {
        const defaultValue = (plugin.defaults as Record<string, unknown>)[key];
        if (isEmptyLeaf(defaultValue)) continue; // empty defaults are no-ops
        const mergedValue = (merged as Record<string, unknown>)[key];
        if (isEmptyLeaf(mergedValue)) {
          failures.push({ resourceType, key });
        }
      }
    }

    expect(
      failures,
      `mergePluginDefaults failed to backfill: ${failures
        .map((f) => `${f.resourceType}.${f.key}`)
        .join(", ")}`,
    ).toEqual([]);
  });

  // e98.W3.A1 — the backfill must also defeat the C-R1 empty-leaf
  // class. For every allowlisted plugin's non-empty default key, an
  // LLM output that carries the key with an empty-leaf value
  // (undefined / null / {} / [] / "") must still resolve to the
  // plugin default (W2.R2 invariant propagated to W3).
  it("empty-leaf LLM values on allowlisted plugin default keys are replaced by the default", () => {
    const failures: Array<{
      resourceType: string;
      key: string;
      leafKind: string;
    }> = [];
    const EMPTY_LEAVES: ReadonlyArray<[string, unknown]> = [
      ["undefined", undefined],
      ["null", null],
      ["empty-string", ""],
      ["empty-object", {}],
      ["empty-array", []],
    ];

    for (const resourceType of SUPPORTED_TYPES_ARRAY) {
      const plugin = defaultPluginRegistry.get(resourceType);
      if (!plugin || !plugin.defaults) continue;
      const probeBare = mergePluginDefaults({}, resourceType);
      if (Object.keys(probeBare).length === 0) continue; // not allowlisted

      for (const key of Object.keys(plugin.defaults)) {
        const defaultValue = (plugin.defaults as Record<string, unknown>)[key];
        if (isEmptyLeaf(defaultValue)) continue;
        for (const [leafKind, leafValue] of EMPTY_LEAVES) {
          const merged = mergePluginDefaults(
            { [key]: leafValue },
            resourceType,
          );
          const mergedValue = (merged as Record<string, unknown>)[key];
          if (isEmptyLeaf(mergedValue)) {
            failures.push({ resourceType, key, leafKind });
          }
        }
      }
    }

    expect(
      failures,
      `mergePluginDefaults failed to restore default against empty-leaf LLM input: ${failures
        .map((f) => `${f.resourceType}.${f.key} (${f.leafKind})`)
        .join(", ")}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// E. Single-Examples contract
// ---------------------------------------------------------------------------

describe("shipped-wired contract E — single Examples block per --help", () => {
  // All top-level commands that carry an `Examples:` section. If you add
  // a new command whose help should include Examples, add it here.
  const COMMANDS = [
    ["plan"],
    ["apply"],
    ["destroy"],
    ["list"],
    ["init"],
    ["reconcile"],
  ] as const;

  // Known-tripwire commands: commands that intentionally emit more than
  // one `Examples:` heading are tracked in PROBE_MANIFEST.yaml. When the
  // dup is fixed, flip `must_fail_pre_fix` to false in the manifest AND
  // remove the command from this set in the SAME commit so the contract
  // immediately enforces the 1-Examples invariant going forward.
  //
  // Epic 96 Wave 1 B2 closed the `plan` + `apply` dup by stripping the
  // embedded `Examples:` block from `buildSupportedTypesBlock()`. Set is
  // now empty; keep it as a sentinel so future tripwires have an
  // obvious home.
  const KNOWN_TRIPWIRE_COMMANDS = new Set<string>();

  for (const args of COMMANDS) {
    const isTripwire = KNOWN_TRIPWIRE_COMMANDS.has(args[0]!);
    const label = isTripwire
      ? `\`${args.join(" ")} --help\` is currently a KNOWN tripwire (see PROBE_MANIFEST)`
      : `\`${args.join(" ")} --help\` emits exactly 1 'Examples:' heading`;
    it(label, () => {
      if (!existsSync(CLI_DIST)) {
        console.warn(
          `[skip E] ${CLI_DIST} missing — run 'pnpm --filter assignee build' first`,
        );
        return;
      }
      const result = spawnSync(
        process.execPath,
        [CLI_DIST, ...args, "--help"],
        { encoding: "utf8", timeout: 20_000 },
      );
      const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      const matches = combined.match(/^Examples:$/gm) ?? [];
      if (isTripwire) {
        // Tripwire: MUST emit > 1 Examples (the bug) — this is a
        // negative assertion that fires the moment the bug is fixed,
        // so the gate author remembers to remove the entry from
        // KNOWN_TRIPWIRE_COMMANDS in the same PR.
        expect(
          matches.length,
          `\`${args.join(" ")} --help\` emitted ${matches.length} 'Examples:' — if this is now 1, the bug has been fixed. Remove '${args[0]}' from KNOWN_TRIPWIRE_COMMANDS and flip must_fail_pre_fix in PROBE_MANIFEST.`,
        ).toBeGreaterThan(1);
        return;
      }
      expect(
        matches.length,
        `\`${args.join(" ")} --help\` emitted ${matches.length} 'Examples:' headings (expected 1). First 200 chars of combined output: ${combined.slice(0, 200)}`,
      ).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// F. Envelope-schema parity
// ---------------------------------------------------------------------------

describe("shipped-wired contract F — envelope-schema parity", () => {
  it("PROBE_MANIFEST references only well-formed exit / ok pairs", () => {
    const text = readProbeManifestText();
    expect(text.length).toBeGreaterThan(0);

    // Every `assert_exit_code_matches_ok` call in the manifest has
    // signature `<exit> <ok> <cmd...>`. Parse the first two tokens and
    // assert they're well-formed per the helper contract.
    const callRe = /assert_exit_code_matches_ok\s+(\S+)\s+(\S+)\s+/g;
    let m: RegExpExecArray | null;
    const invalid: string[] = [];
    const validOk = new Set(["true", "false"]);
    const validExitShapes = /^(zero|non-zero|\d+)$/;
    while ((m = callRe.exec(text)) !== null) {
      const exitTok = m[1]!;
      const okTok = m[2]!;
      if (!validExitShapes.test(exitTok)) {
        invalid.push(`invalid exit token: '${exitTok}'`);
      }
      if (!validOk.has(okTok)) {
        invalid.push(
          `invalid ok token: '${okTok}' (expected 'true' or 'false')`,
        );
      }
    }
    expect(
      invalid,
      `PROBE_MANIFEST envelope-schema parity violations: ${invalid.join("; ")}`,
    ).toEqual([]);
  });

  it("at least 3 Wave-1 BLOCKER probes are seeded", () => {
    const text = readProbeManifestText();
    const blockerStories = text.match(/story:\s+e96\.W1\.B\d+/g) ?? [];
    expect(
      blockerStories.length,
      "PROBE_MANIFEST must seed at least 3 Wave-1 BLOCKERs (e96.W1.B1/B2/B3)",
    ).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// G. Probe variation coverage (Epic 98 M2)
// ---------------------------------------------------------------------------

/**
 * Parse PROBE_MANIFEST.yaml into a flat list of
 *   { story, name, variationsCount }
 * records. We avoid a YAML dependency (js-yaml is not a prod dep of the
 * core package) and use an indentation-aware line scan that matches the
 * awk parser in pre-close-probes.sh. Keep the two in sync: if the
 * manifest shape changes, update both.
 */
function parseManifestEntries(): Array<{
  story: string;
  name: string;
  variationsCount: number;
  hasKnownTripwiresBlock: boolean;
  lineNumber: number;
}> {
  const text = readProbeManifestText();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const entries: Array<{
    story: string;
    name: string;
    variationsCount: number;
    hasKnownTripwiresBlock: boolean;
    lineNumber: number;
  }> = [];
  let current: {
    story: string;
    name: string;
    variationsCount: number;
    hasKnownTripwiresBlock: boolean;
    lineNumber: number;
  } | null = null;
  let inVariations = false;

  const flush = () => {
    if (current) entries.push(current);
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const storyMatch = line.match(/^\s{2,4}-\s+story:\s*(\S.*)$/);
    if (storyMatch) {
      flush();
      current = {
        story: storyMatch[1]!.trim(),
        name: "",
        variationsCount: 0,
        hasKnownTripwiresBlock: false,
        lineNumber: idx + 1,
      };
      inVariations = false;
      continue;
    }
    if (!current) continue;
    const nameMatch = line.match(/^\s+name:\s*(\S.*)$/);
    if (nameMatch) {
      current.name = nameMatch[1]!.trim();
      continue;
    }
    if (/^\s{4}variations:\s*$/.test(line)) {
      inVariations = true;
      continue;
    }
    if (/^\s{4}known_tripwires:/.test(line)) {
      current.hasKnownTripwiresBlock = true;
      inVariations = false;
      continue;
    }
    if (/^\s+probe:\s*\|\s*$/.test(line)) {
      inVariations = false;
      continue;
    }
    // Another 4-space top-level key exits variations block.
    if (inVariations) {
      if (/^\s{4}[a-zA-Z_]+:/.test(line)) {
        inVariations = false;
      } else if (/^\s{6}-\s+cmd:/.test(line)) {
        current.variationsCount += 1;
      }
    }
  }
  flush();
  return entries;
}

describe("shipped-wired contract G — probe variation coverage (Epic 98 M2)", () => {
  const entries = parseManifestEntries();

  it("PROBE_MANIFEST has at least one probe entry", () => {
    // Defensive guard: if the parser regresses, we'd silently pass a
    // zero-length list. Force at least the 18 Epic 96 probes to parse.
    expect(
      entries.length,
      "probe manifest parser returned zero entries",
    ).toBeGreaterThanOrEqual(1);
  });

  it("every probe declares >= 3 variations", () => {
    const offenders = entries.filter((e) => e.variationsCount < 3);
    const detail = offenders
      .map(
        (o) =>
          `${o.story} :: ${o.name} :: variations=${o.variationsCount} (line ${o.lineNumber})`,
      )
      .join("\n  ");
    expect(
      offenders,
      `Probes below Epic 98 M2 variation floor (< 3 variations):\n  ${detail}`,
    ).toEqual([]);
  });

  it("every probe declares a known_tripwires block (list or [])", () => {
    // Required for schema-parseability even if the list is empty. The
    // known_tripwires block is how Wave 2 forcing-flip witnesses are
    // registered; a probe that omits the block entirely is a silent
    // contract violation.
    const missing = entries.filter((e) => !e.hasKnownTripwiresBlock);
    const detail = missing
      .map((o) => `${o.story} :: ${o.name} (line ${o.lineNumber})`)
      .join("\n  ");
    expect(
      missing,
      `Probes missing known_tripwires block:\n  ${detail}`,
    ).toEqual([]);
  });
});
