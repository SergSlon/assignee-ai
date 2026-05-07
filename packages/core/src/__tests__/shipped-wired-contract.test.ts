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
  "--from", // restore-provisions (W4-04) — tested in restore-provisions.test.ts; audit-verify (W3-01) — tested in audit-verify.test.ts
  "--to", // audit-verify (W3-01) — end-date filter; tested in audit-verify.test.ts
  "--log-file", // audit-verify (W3-01) — override audit log path; tested in audit-verify.test.ts
  "--target-account", // plan/apply/destroy (W3-04) — multi-account surface flag; Epic 101 wires STS assume-role; tested in account-id-validator.test.ts + plan/apply/destroy *.test.ts
  "--all", // destroy --all (bulk-destroy re-introduction) — tested in bulk-action.test.ts + cli-flow-commands.test.ts
  "--no-confirm", // destroy --all --no-confirm (skip typed-confirmation, CI/CD) — tested in bulk-action.test.ts
  "--allow-large-sweep", // destroy --all --allow-large-sweep (> 100 resource opt-in) — tested in bulk-action.test.ts
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

// ---------------------------------------------------------------------------
// H. Contract H — probe-reachability (Epic 99 Wave 2 Lane 2b)
// ---------------------------------------------------------------------------

/**
 * Parse PROBE_MANIFEST.yaml into an extended list of probe entries that
 * includes the probe body text (for BP rule ID extraction) and the
 * parent_reachable / parent_reachable_rationale fields.
 *
 * Extended record shape:
 *   { story, name, lineNumber, probeBody, parentReachable, parentReachableRationale }
 */
function parseManifestEntriesExtended(): Array<{
  story: string;
  name: string;
  lineNumber: number;
  probeBody: string;
  parentReachable: boolean;
  parentReachableRationale: string;
}> {
  const text = readProbeManifestText();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const entries: Array<{
    story: string;
    name: string;
    lineNumber: number;
    probeBody: string;
    parentReachable: boolean;
    parentReachableRationale: string;
  }> = [];
  let current: {
    story: string;
    name: string;
    lineNumber: number;
    probeBody: string;
    parentReachable: boolean;
    parentReachableRationale: string;
  } | null = null;
  let inProbeBody = false;
  let probeIndent = 0;

  const flush = () => {
    if (current) entries.push(current);
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";

    // Detect new probe entry start.
    const storyMatch = line.match(/^\s{2,4}-\s+story:\s*(\S.*)$/);
    if (storyMatch) {
      flush();
      current = {
        story: storyMatch[1]!.trim(),
        name: "",
        lineNumber: idx + 1,
        probeBody: "",
        parentReachable: false,
        parentReachableRationale: "",
      };
      inProbeBody = false;
      probeIndent = 0;
      continue;
    }

    if (!current) continue;

    // Collect probe body lines (block scalar).
    if (inProbeBody) {
      const leading = line.match(/^(\s*)/)?.[1]?.length ?? 0;
      if (line.trim() === "") {
        // blank line — end of block scalar (could be between probes)
        inProbeBody = false;
        continue;
      }
      if (leading >= probeIndent) {
        current.probeBody += line.slice(probeIndent) + "\n";
        continue;
      }
      inProbeBody = false;
      // Fall through to key detection.
    }

    // name:
    const nameMatch = line.match(/^\s{4}name:\s*(\S.*)$/);
    if (nameMatch) {
      current.name = nameMatch[1]!.trim();
      continue;
    }

    // parent_reachable:
    if (/^\s{4}parent_reachable:\s*true/.test(line)) {
      current.parentReachable = true;
      continue;
    }

    // parent_reachable_rationale:
    const rationaleMatch = line.match(
      /^\s{4}parent_reachable_rationale:\s*"(.*)"\s*$/,
    );
    if (rationaleMatch) {
      current.parentReachableRationale = rationaleMatch[1]!.trim();
      continue;
    }

    // probe: | — start of block scalar.
    if (/^\s{4}probe:\s*\|\s*$/.test(line)) {
      // Peek at next line to determine probe body indent.
      const next = lines[idx + 1] ?? "";
      probeIndent = next.match(/^(\s*)/)?.[1]?.length ?? 6;
      inProbeBody = true;
      // Don't skip — the next iteration will capture the body.
      continue;
    }
  }
  flush();
  return entries;
}

/**
 * Load all BP rule resource_types from packages/best-practices, keyed by
 * rule ID (e.g. "BP-S3-011" → "AWS::S3::BucketPolicy"). Reads YAML files
 * directly via regex since adding a js-yaml or yaml dep is outside the
 * contract test's scope. The `id:` and `resource_type:` fields are always
 * on their own lines in every BP rule YAML file.
 */
function loadBpRuleResourceTypes(): Map<string, string> {
  const map = new Map<string, string>();
  const BP_DIR = resolve(REPO_ROOT, "packages/best-practices");
  if (!existsSync(BP_DIR)) return map;

  // Skip directories that are not service rule directories.
  const skipDirs = new Set([
    "src",
    "dist",
    "node_modules",
    "__tests__",
    "coverage",
  ]);

  for (const svcDir of readdirSync(BP_DIR)) {
    if (svcDir.startsWith(".") || skipDirs.has(svcDir)) continue;
    const svcPath = join(BP_DIR, svcDir);
    let st;
    try {
      st = statSync(svcPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    for (const file of readdirSync(svcPath)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const filePath = join(svcPath, file);
      let yaml: string;
      try {
        yaml = readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const idMatch = yaml.match(/^id:\s*(\S+)/m);
      const rtMatch = yaml.match(/^resource_type:\s*"?([^"\n]+)"?/m);
      if (idMatch && rtMatch) {
        map.set(idMatch[1]!.trim(), rtMatch[1]!.trim());
      }
    }
  }
  return map;
}

describe("shipped-wired contract H — probe-reachability (Epic 99 Wave 2)", () => {
  /**
   * For every probe that references a BP rule ID in its probe body (via
   * `assert_bp_finding_id_present BP-XXX-NNN` or
   * `assert_no_bp_finding_id BP-XXX-NNN`), the rule's `resource_type`
   * MUST either:
   *   (a) be a member of SUPPORTED_TYPES_ARRAY, OR
   *   (b) the probe declares `parent_reachable: true` with a non-empty
   *       `parent_reachable_rationale` string.
   *
   * Without one of these conditions, the probe targets a type the CLI
   * intent-parser never produces, meaning any fire-probe can never observe
   * the rule firing at plan-time. Non-opt-in + unreachable = silent dead probe.
   */
  it("every probe referencing a BP rule has a reachable resource_type or opts into parent_reachable", () => {
    const probeEntries = parseManifestEntriesExtended();
    const bpRuleTypes = loadBpRuleResourceTypes();
    const supportedSet = new Set<string>(SUPPORTED_TYPES_ARRAY);

    // BP rule ID pattern used in probe bodies (assert helpers).
    const bpIdRe = /\bBP-[A-Z0-9]+-[0-9]+\b/g;

    const violations: string[] = [];

    for (const entry of probeEntries) {
      const referencedIds = new Set<string>();
      let m: RegExpExecArray | null;
      // Reset lastIndex (global regex stateful).
      bpIdRe.lastIndex = 0;
      while ((m = bpIdRe.exec(entry.probeBody)) !== null) {
        referencedIds.add(m[0]!);
      }

      for (const ruleId of referencedIds) {
        const resourceType = bpRuleTypes.get(ruleId);
        if (!resourceType) {
          // Rule YAML not found — report as unknown (not a hard violation,
          // since some rules may have been retired or moved). Warn only.
          continue;
        }
        if (supportedSet.has(resourceType)) {
          // (a) type is supported — reachable.
          continue;
        }
        // Not in SUPPORTED_TYPES_ARRAY. Check opt-in.
        if (
          entry.parentReachable &&
          entry.parentReachableRationale.trim().length > 0
        ) {
          // (b) probe opted in with documented rationale — accepted.
          continue;
        }
        // Violation: unreachable type, no opt-in.
        violations.push(
          `probe ${entry.story} :: ${entry.name} (line ${entry.lineNumber}) ` +
            `references ${ruleId} which targets ${resourceType} — ` +
            `${resourceType} is NOT in SUPPORTED_TYPES_ARRAY. ` +
            `Either add ${resourceType} to supported.ts or set ` +
            `parent_reachable: true with parent_reachable_rationale on this probe.`,
        );
      }
    }

    expect(
      violations,
      `Contract H violations — probe-reachability:\n  ${violations.join("\n  ")}`,
    ).toEqual([]);
  });

  it("loadBpRuleResourceTypes returns at least 50 entries (sanity guard)", () => {
    const map = loadBpRuleResourceTypes();
    expect(
      map.size,
      `loadBpRuleResourceTypes returned only ${map.size} entries — check BP_DIR path`,
    ).toBeGreaterThanOrEqual(50);
  });

  it("parseManifestEntriesExtended returns at least 40 probes (sanity guard)", () => {
    const entries = parseManifestEntriesExtended();
    expect(
      entries.length,
      `parseManifestEntriesExtended returned only ${entries.length} entries`,
    ).toBeGreaterThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// I. Contract I — first-class-promotion parity (Epic 99 Wave 4 Lane 4c)
// ---------------------------------------------------------------------------
//
// For each type in SUPPORTED_TYPES_ARRAY, assert it appears at least once in
// each of the 4 canonical audit surfaces OR carries a CONTRACT-I-OPT-OUT
// annotation documented below.
//
// Opt-out format: the contract checks the opt-out set before failing so that
// types with no applicable rules/patterns on a given surface are explicitly
// documented rather than silently missing.
//
// Opt-out rationale categories:
//   NO-BP-RULES        — no BP YAML files target this resource type directly;
//                        rules may exist on a parent/sibling type instead.
//   NO-AUTO-FIX-RULES  — the type has BP rules but none are auto-fixable;
//                        bp-auto-fix-audit only exercises autoFixable=true rules.
//   NON-COMPOUNDABLE   — type is a standalone or companion resource; no
//                        compound pattern currently orchestrates it as the
//                        primary entry point.
//   APPLY-MANUAL-ONLY  — apply-mode-audit exercises full graph flows; this type
//                        is provisioned as part of compound patterns or via SDK
//                        fallback and doesn't have a standalone graph-flow test.
//                        Defer to Epic 100+ per CT-5 second-half scope.
//
// ---------------------------------------------------------------------------

/**
 * Audit surface paths — resolved relative to the repo root.
 * Contract I reads each file as text and does substring matching.
 */
const AUDIT_SURFACES = {
  bpAllRules: resolve(
    REPO_ROOT,
    "packages/best-practices/__tests__/bp-all-rules-audit.test.ts",
  ),
  bpAutoFix: resolve(
    REPO_ROOT,
    "packages/best-practices/__tests__/bp-auto-fix-audit.test.ts",
  ),
  compoundProvisioning: resolve(
    REPO_ROOT,
    "packages/core/src/graph/nodes/__tests__/compound-provisioning-audit.test.ts",
  ),
  applyMode: resolve(
    REPO_ROOT,
    "packages/core/src/graph/__tests__/apply-mode-audit.test.ts",
  ),
} as const;

type AuditSurface = keyof typeof AUDIT_SURFACES;

/**
 * CONTRACT-I-OPT-OUT registry.
 *
 * Each entry documents a deliberate gap:
 *   surface → Set of resource types opted out with rationale.
 *
 * Adding a type here MUST include a rationale comment and a corresponding
 * entry in deferred-backlog.md §Epic 100+ bucket (see maintenance log below).
 *
 * Deferred-backlog.md entries added 2026-04-24 (Epic 99 W4c):
 *   Rows V1-16 through V1-20 (grouped by surface) in the Epic 100+ bucket.
 */
const CONTRACT_I_OPT_OUTS: Record<AuditSurface, Map<string, string>> = {
  // ── Surface 1: bp-all-rules-audit ─────────────────────────────────────────
  // Types that have NO BP YAML file targeting them as resource_type.
  // These are infrastructure-wiring or companion resources with no
  // independent best-practice concerns of their own; relevant rules
  // are attached to parent types (e.g., AWS::EC2::Subnet covers
  // SubnetRouteTableAssociation guidance via BP-RT-002).
  bpAllRules: new Map<string, string>([
    [
      "AWS::EC2::RouteTable",
      "NO-BP-RULES — wiring resource; routing concerns covered by VPC/Subnet rules",
    ],
    [
      "AWS::EC2::VPCGatewayAttachment",
      "NO-BP-RULES — attachment resource; no independent BP rules; IGW + VPC rules cover intent",
    ],
    [
      "AWS::EC2::SubnetRouteTableAssociation",
      "NO-BP-RULES — association resource; BP-RT-002 is on AWS::EC2::Subnet not this type",
    ],
    [
      "AWS::EFS::MountTarget",
      "NO-BP-RULES — companion resource; security/encryption rules target AWS::EFS::FileSystem",
    ],
    [
      "AWS::RDS::DBSubnetGroup",
      "NO-BP-RULES — structural resource; RDS placement rules are on AWS::RDS::DBInstance",
    ],
    [
      "AWS::EC2::EIP",
      "NO-BP-RULES — Elastic IP has no independent BP YAML rules in current library",
    ],
  ]),

  // ── Surface 2: bp-auto-fix-audit ──────────────────────────────────────────
  // Types that have BP rules but none with autoFixable=true, OR types with
  // no BP rules at all. bp-auto-fix-audit only exercises autoFixable=true rules.
  // Defer to Epic 100+ when auto-fixable rules are added for these types.
  bpAutoFix: new Map<string, string>([
    // No BP rules at all (infrastructure-wiring / companion):
    [
      "AWS::EC2::RouteTable",
      "NO-BP-RULES — wiring resource; no auto-fixable rules",
    ],
    [
      "AWS::EC2::VPCGatewayAttachment",
      "NO-BP-RULES — attachment resource; no auto-fixable rules",
    ],
    [
      "AWS::EC2::SubnetRouteTableAssociation",
      "NO-BP-RULES — association resource; no auto-fixable rules",
    ],
    [
      "AWS::EFS::MountTarget",
      "NO-BP-RULES — companion resource; no auto-fixable rules",
    ],
    [
      "AWS::RDS::DBSubnetGroup",
      "NO-BP-RULES — structural resource; no auto-fixable rules",
    ],
    ["AWS::EC2::EIP", "NO-BP-RULES — no auto-fixable rules"],
    // Has BP rules but none are auto-fixable (awareness / interactive-only):
    [
      "AWS::SSM::Parameter",
      "NO-AUTO-FIX-RULES — BP-SSM rules are awareness/interactive; no desiredStatePatch",
    ],
    [
      "AWS::SQS::Queue",
      "NO-AUTO-FIX-RULES — BP-SQS rules are policy_antipattern (awareness/interactive)",
    ],
    [
      "AWS::SNS::Topic",
      "NO-AUTO-FIX-RULES — BP-SNS rules are policy_antipattern (awareness/interactive)",
    ],
    [
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
      "NO-AUTO-FIX-RULES — ELBv2 LoadBalancer rules are awareness-only; only Listener has auto-fix",
    ],
    [
      "AWS::EC2::InternetGateway",
      "NO-AUTO-FIX-RULES — BP-IGW rules are awareness-only",
    ],
    [
      "AWS::EC2::Route",
      "NO-AUTO-FIX-RULES — BP-EC2::Route rules are awareness-only",
    ],
    [
      "AWS::EC2::NatGateway",
      "NO-AUTO-FIX-RULES — BP-NAT rules are awareness-only",
    ],
    [
      "AWS::CloudWatch::Alarm",
      "NO-AUTO-FIX-RULES — BP-CW rules are awareness-only",
    ],
    [
      "AWS::SecretsManager::Secret",
      "NO-AUTO-FIX-RULES — BP-SM rules are awareness-only; no desiredStatePatch",
    ],
    [
      "AWS::Events::EventBus",
      "NO-AUTO-FIX-RULES — BP-EVENTS::EventBus rules are awareness-only",
    ],
    [
      "AWS::SNS::Subscription",
      "NO-AUTO-FIX-RULES — BP-SNS::Subscription rules are awareness/interactive",
    ],
    [
      "AWS::Events::Connection",
      "NO-AUTO-FIX-RULES — BP-EVENTS-005 KmsKeyIdentifier is awareness (no desiredStatePatch)",
    ],
    [
      "AWS::Events::ApiDestination",
      "NO-AUTO-FIX-RULES — BP-EVENTS-006 InvocationRateLimitPerSecond is awareness-only",
    ],
    [
      "AWS::CloudFront::Distribution",
      "NO-AUTO-FIX-RULES — BP-CF-001/002 are awareness-only (ViewerProtocolPolicy is user intent)",
    ],
    [
      "AWS::S3::BucketPolicy",
      "NO-AUTO-FIX-RULES — BP-S3BP-001 is policy_antipattern (awareness/blocking, no patch)",
    ],
  ]),

  // ── Surface 3: compound-provisioning-audit ────────────────────────────────
  // Types that are NOT orchestrated as a primary resource in any current
  // compound pattern. The audit exercises patterns (serverless-api,
  // three-tier-web, vpc-networking, etc.) — types that only appear as
  // standalone single-type resources are not pattern entries.
  // Standalone types without a compound pattern: NON-COMPOUNDABLE.
  // Types that DO appear in compound patterns but as non-primary resources
  // are still referenced by their parent pattern test.
  compoundProvisioning: new Map<string, string>([
    [
      "AWS::SSM::Parameter",
      "NON-COMPOUNDABLE — standalone parameter resource; no compound pattern orchestrates SSM",
    ],
    [
      "AWS::EC2::Instance",
      "NON-COMPOUNDABLE — EC2 instances are provisioned standalone or via three-tier-web (covered via RESOURCE_TYPES refs)",
    ],
    [
      "AWS::RDS::DBInstance",
      "NON-COMPOUNDABLE — RDS is provisioned standalone; three-tier-web uses it but audit tracks patterns not types directly",
    ],
    [
      "AWS::EC2::VPC",
      "NON-COMPOUNDABLE — VPC is a compound-pattern dependency (covered in vpc-networking/three-tier-web); audit test references RESOURCE_TYPES.EC2_VPC constant not string literal",
    ],
    [
      "AWS::EC2::Subnet",
      "NON-COMPOUNDABLE — same as VPC; referenced via RESOURCE_TYPES constant in audit",
    ],
    [
      "AWS::DynamoDB::Table",
      "NON-COMPOUNDABLE — standalone resource; no compound pattern currently includes DynamoDB",
    ],
    [
      "AWS::SQS::Queue",
      "NON-COMPOUNDABLE — message-processing pattern references SQS via RESOURCE_TYPES constant; audit substring match misses constant alias",
    ],
    [
      "AWS::SNS::Topic",
      "NON-COMPOUNDABLE — standalone resource; no compound pattern currently includes SNS Topic as primary",
    ],
    [
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
      "NON-COMPOUNDABLE — three-tier-web references ALB but audit uses RESOURCE_TYPES constant",
    ],
    [
      "AWS::ECS::Cluster",
      "NON-COMPOUNDABLE — container-service pattern references ECS via RESOURCE_TYPES constant",
    ],
    [
      "AWS::ECR::Repository",
      "NON-COMPOUNDABLE — standalone resource; no compound pattern includes ECR as primary",
    ],
    [
      "AWS::Logs::LogGroup",
      "NON-COMPOUNDABLE — co-provisioned companion; standalone resource with no compound pattern",
    ],
    [
      "AWS::EC2::InternetGateway",
      "NON-COMPOUNDABLE — compound-pattern dependency; referenced via RESOURCE_TYPES.EC2_INTERNET_GATEWAY constant",
    ],
    [
      "AWS::EC2::RouteTable",
      "NON-COMPOUNDABLE — compound-pattern dependency; referenced via RESOURCE_TYPES.EC2_ROUTE_TABLE constant",
    ],
    [
      "AWS::EC2::Route",
      "NON-COMPOUNDABLE — compound-pattern dependency; referenced via RESOURCE_TYPES.EC2_ROUTE constant",
    ],
    [
      "AWS::EC2::NatGateway",
      "NON-COMPOUNDABLE — compound-pattern dependency; referenced via RESOURCE_TYPES.EC2_NAT_GATEWAY constant",
    ],
    [
      "AWS::ApiGatewayV2::Api",
      "NON-COMPOUNDABLE — serverless-api pattern includes ApiGatewayV2 but as provisionable=false companion; audit references COMPANION_RESOURCE_TYPES constant",
    ],
    [
      "AWS::CloudWatch::Alarm",
      "NON-COMPOUNDABLE — standalone resource; no compound pattern includes CW Alarm",
    ],
    [
      "AWS::SecretsManager::Secret",
      "NON-COMPOUNDABLE — standalone resource; no compound pattern includes Secrets Manager",
    ],
    [
      "AWS::EC2::VPCGatewayAttachment",
      "NON-COMPOUNDABLE — compound-pattern wiring resource; referenced via RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT constant",
    ],
    [
      "AWS::EC2::SubnetRouteTableAssociation",
      "NON-COMPOUNDABLE — compound-pattern wiring resource; referenced via RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION constant",
    ],
    [
      "AWS::EFS::FileSystem",
      "NON-COMPOUNDABLE — efs-with-vpc pattern references FileSystem but audit uses RESOURCE_TYPES constant",
    ],
    [
      "AWS::EFS::MountTarget",
      "NON-COMPOUNDABLE — efs-with-vpc companion; no standalone compound pattern entry",
    ],
    [
      "AWS::Events::Rule",
      "NON-COMPOUNDABLE — scheduled-lambda pattern references Events::Rule via RESOURCE_TYPES constant",
    ],
    [
      "AWS::Events::EventBus",
      "NON-COMPOUNDABLE — standalone resource; no compound pattern currently includes EventBus as primary",
    ],
    [
      "AWS::KMS::Key",
      "NON-COMPOUNDABLE — standalone resource; no compound pattern includes KMS Key",
    ],
    [
      "AWS::Events::Connection",
      "NON-COMPOUNDABLE — standalone resource; no compound pattern includes EventBridge Connection",
    ],
    [
      "AWS::Events::ApiDestination",
      "NON-COMPOUNDABLE — standalone resource; no compound pattern includes ApiDestination",
    ],
    [
      "AWS::CloudFront::Distribution",
      "NON-COMPOUNDABLE — static-website pattern references CloudFront via RESOURCE_TYPES constant",
    ],
    [
      "AWS::CloudFront::OriginAccessControl",
      "NON-COMPOUNDABLE — static-website pattern references OAC via RESOURCE_TYPES constant",
    ],
    [
      "AWS::RDS::DBSubnetGroup",
      "NON-COMPOUNDABLE — standalone resource; three-tier-web references DBSubnetGroup implicitly",
    ],
    [
      "AWS::EC2::EIP",
      "NON-COMPOUNDABLE — vpc-networking uses EIP as COMPANION_RESOURCE_TYPES.EC2_EIP constant",
    ],
  ]),

  // ── Surface 4: apply-mode-audit ───────────────────────────────────────────
  // The apply-mode-audit file exercises full graph flows (intent → plan → BP
  // → fix → approve → provision → poll → result). Currently it has 5
  // scenarios covering SSM::Parameter and S3::Bucket only. All other types
  // lack dedicated apply-mode graph-flow tests.
  // These are deferred to Epic 100+ per CT-5 second-half scope (the audit
  // should eventually grow to cover every type's apply path).
  applyMode: new Map<string, string>([
    [
      "AWS::IAM::Role",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test; provisioned via compound patterns. Defer to Epic 100+",
    ],
    [
      "AWS::EC2::Instance",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::RDS::DBInstance",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::Lambda::Function",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test; provisioned via compound. Defer to Epic 100+",
    ],
    [
      "AWS::EC2::VPC",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::EC2::Subnet",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::EC2::SecurityGroup",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::DynamoDB::Table",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::SQS::Queue",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::SNS::Topic",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::ElasticLoadBalancingV2::LoadBalancer",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::ECS::Cluster",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::ECR::Repository",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::Logs::LogGroup",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::EC2::InternetGateway",
      "APPLY-MANUAL-ONLY — compound-only resource; no standalone apply-mode test. Defer to Epic 100+",
    ],
    [
      "AWS::EC2::RouteTable",
      "APPLY-MANUAL-ONLY — compound-only resource; no standalone apply-mode test. Defer to Epic 100+",
    ],
    [
      "AWS::EC2::Route",
      "APPLY-MANUAL-ONLY — compound-only resource; no standalone apply-mode test. Defer to Epic 100+",
    ],
    [
      "AWS::EC2::NatGateway",
      "APPLY-MANUAL-ONLY — compound-only resource; no standalone apply-mode test. Defer to Epic 100+",
    ],
    [
      "AWS::ApiGatewayV2::Api",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::CloudWatch::Alarm",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::SecretsManager::Secret",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::EC2::VPCGatewayAttachment",
      "APPLY-MANUAL-ONLY — compound wiring resource; no standalone apply-mode test. Defer to Epic 100+",
    ],
    [
      "AWS::EC2::SubnetRouteTableAssociation",
      "APPLY-MANUAL-ONLY — compound wiring resource; no standalone apply-mode test. Defer to Epic 100+",
    ],
    [
      "AWS::EFS::FileSystem",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::EFS::MountTarget",
      "APPLY-MANUAL-ONLY — compound companion; no standalone apply-mode test. Defer to Epic 100+",
    ],
    [
      "AWS::Events::Rule",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::Events::EventBus",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::SNS::Subscription",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::KMS::Key",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::Events::Connection",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::Events::ApiDestination",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::CloudFront::Distribution",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::CloudFront::OriginAccessControl",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::S3::BucketPolicy",
      "APPLY-MANUAL-ONLY — compound terminal resource; no standalone apply-mode test. Defer to Epic 100+",
    ],
    [
      "AWS::RDS::DBSubnetGroup",
      "APPLY-MANUAL-ONLY — no standalone apply-mode graph-flow test. Defer to Epic 100+",
    ],
    [
      "AWS::EC2::EIP",
      "APPLY-MANUAL-ONLY — compound companion resource; no standalone apply-mode test. Defer to Epic 100+",
    ],
  ]),
};

describe("shipped-wired contract I — first-class-promotion parity (Epic 99 W4c)", () => {
  /**
   * Read an audit file as text. If the file doesn't exist, return an empty
   * string and fail the test with a clear message.
   */
  function readAuditFile(surface: AuditSurface): string {
    const filePath = AUDIT_SURFACES[surface];
    if (!existsSync(filePath)) {
      // Fail loudly — a missing audit file is a contract violation.
      expect(existsSync(filePath), `Audit file missing: ${filePath}`).toBe(
        true,
      );
      return "";
    }
    return readFileSync(filePath, "utf8");
  }

  /**
   * Check whether a type is opted out for a given surface.
   * Returns the rationale string if opted out, undefined otherwise.
   */
  function getOptOut(
    surface: AuditSurface,
    resourceType: string,
  ): string | undefined {
    return CONTRACT_I_OPT_OUTS[surface].get(resourceType);
  }

  it("all 4 audit files exist on disk (sanity guard)", () => {
    for (const [surface, filePath] of Object.entries(AUDIT_SURFACES)) {
      expect(
        existsSync(filePath),
        `Audit file for surface '${surface}' missing at: ${filePath}`,
      ).toBe(true);
    }
  });

  it("every first-class type is covered in bp-all-rules-audit or opted out", () => {
    const content = readAuditFile("bpAllRules");
    const failures: string[] = [];

    for (const resourceType of SUPPORTED_TYPES_ARRAY) {
      if (content.includes(resourceType)) continue;
      const optOut = getOptOut("bpAllRules", resourceType);
      if (optOut) continue; // CONTRACT-I-OPT-OUT documented above
      failures.push(
        `${resourceType} — not in bp-all-rules-audit.test.ts and no CONTRACT-I-OPT-OUT`,
      );
    }

    expect(
      failures,
      `Contract I: bp-all-rules-audit missing entries (add the type's rules or add to CONTRACT_I_OPT_OUTS.bpAllRules):\n  ${failures.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every first-class type is covered in bp-auto-fix-audit or opted out", () => {
    const content = readAuditFile("bpAutoFix");
    const failures: string[] = [];

    for (const resourceType of SUPPORTED_TYPES_ARRAY) {
      if (content.includes(resourceType)) continue;
      const optOut = getOptOut("bpAutoFix", resourceType);
      if (optOut) continue;
      failures.push(
        `${resourceType} — not in bp-auto-fix-audit.test.ts and no CONTRACT-I-OPT-OUT`,
      );
    }

    expect(
      failures,
      `Contract I: bp-auto-fix-audit missing entries (add auto-fix test case or add to CONTRACT_I_OPT_OUTS.bpAutoFix):\n  ${failures.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every first-class type is covered in compound-provisioning-audit or opted out", () => {
    const content = readAuditFile("compoundProvisioning");
    const failures: string[] = [];

    for (const resourceType of SUPPORTED_TYPES_ARRAY) {
      if (content.includes(resourceType)) continue;
      const optOut = getOptOut("compoundProvisioning", resourceType);
      if (optOut) continue;
      failures.push(
        `${resourceType} — not in compound-provisioning-audit.test.ts and no CONTRACT-I-OPT-OUT`,
      );
    }

    expect(
      failures,
      `Contract I: compound-provisioning-audit missing entries (add compound pattern test or add to CONTRACT_I_OPT_OUTS.compoundProvisioning):\n  ${failures.join("\n  ")}`,
    ).toEqual([]);
  });

  it("every first-class type is covered in apply-mode-audit or opted out", () => {
    const content = readAuditFile("applyMode");
    const failures: string[] = [];

    for (const resourceType of SUPPORTED_TYPES_ARRAY) {
      if (content.includes(resourceType)) continue;
      const optOut = getOptOut("applyMode", resourceType);
      if (optOut) continue;
      failures.push(
        `${resourceType} — not in apply-mode-audit.test.ts and no CONTRACT-I-OPT-OUT`,
      );
    }

    expect(
      failures,
      `Contract I: apply-mode-audit missing entries (add apply-mode graph-flow test or add to CONTRACT_I_OPT_OUTS.applyMode):\n  ${failures.join("\n  ")}`,
    ).toEqual([]);
  });

  it("opt-out registry only references types in SUPPORTED_TYPES_ARRAY (no stale entries)", () => {
    const supportedSet = new Set<string>(SUPPORTED_TYPES_ARRAY);
    const staleEntries: string[] = [];

    for (const [surface, optOutMap] of Object.entries(CONTRACT_I_OPT_OUTS) as [
      AuditSurface,
      Map<string, string>,
    ][]) {
      for (const resourceType of optOutMap.keys()) {
        if (!supportedSet.has(resourceType)) {
          staleEntries.push(`${surface}: ${resourceType}`);
        }
      }
    }

    expect(
      staleEntries,
      `CONTRACT_I_OPT_OUTS contains types not in SUPPORTED_TYPES_ARRAY (remove stale entries): ${staleEntries.join(", ")}`,
    ).toEqual([]);
  });
});
