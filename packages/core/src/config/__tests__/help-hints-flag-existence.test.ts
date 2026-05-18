/**
 * Flag-existence drift guard — Epic 92 wave 3.a (story e92-3a).
 *
 * Scans every user-facing `.ts` file under `packages/core/src/` and
 * `apps/cli/src/` for `assignee <cmd>[^"]*--<flag>` triples embedded in
 * string literals (help text, error hints, advisory messages, docs
 * examples, log strings, etc.). Every discovered `(cmd, flag)` pair is
 * cross-checked against the Commander `.option(...)` list statically
 * parsed from the matching subcommand file plus the global options
 * declared on the root `Command` in `apps/cli/src/index.ts`.
 *
 * Closes findings:
 *
 * - **B-18** (generalised) — Epic 88-it1 flagged `status --resume`
 *   referenced in error text while the `status` subcommand never
 *   registered a `--resume` option. This test catches that class of
 *   drift for every subcommand simultaneously.
 * - **D-12** — Emitted strings referencing nonexistent flags
 *   (`status --resume`, `list --output json`, `status --output json`,
 *   `reconcile --auto-reconcile` deprecation flag no longer exists).
 *   Each drift surfaces as a distinct test failure with the offending
 *   file:line and the `<cmd> --<flag>` triple.
 *
 * Design notes:
 *
 * - Static parsing only. No Commander/runtime import — the test runs
 *   in every vitest execution (including CI without network) and must
 *   not depend on the CLI being runnable.
 * - Tests and third-party captured responses are excluded from the
 *   emitted-string scan so ad-hoc test fixtures that intentionally
 *   reference deprecated flags for coverage don't fail the guard.
 *   Commander option definitions (the ground truth) are parsed from
 *   the `apps/cli/src/commands/<cmd>.ts` source files.
 * - The global options (`--verbose`, `--no-color`, `--color`) live on
 *   the root `Command` in `apps/cli/src/index.ts` and apply to every
 *   subcommand. The parser treats them as implicitly registered for
 *   every command.
 * - Commander's `--no-<flag>` syntax registers both `--<flag>` (with
 *   default true) and `--no-<flag>` as the negation. We accept either
 *   form as valid.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const CLI_SRC = join(REPO_ROOT, "apps/cli/src");
const CORE_SRC = join(REPO_ROOT, "packages/core/src");
const COMMANDS_DIR = join(CLI_SRC, "commands");
const CLI_ENTRY = join(CLI_SRC, "index.ts");

const EXCLUDE_DIR_PATTERNS: RegExp[] = [
  /[\\/]__tests__[\\/]/,
  /[\\/]test-fixtures[\\/]/,
  /[\\/]captured-responses[\\/]/,
  /[\\/]scripts[\\/]captured-responses[\\/]/,
  /[\\/]e2e[\\/]/,
  /[\\/]dist[\\/]/,
  /[\\/]build[\\/]/,
  /[\\/]node_modules[\\/]/,
];
const EXCLUDE_FILE_SUFFIXES = [".test.ts", ".spec.ts", ".test.mts"];

const SUBCOMMAND_FILES: Record<string, string> = {
  apply: join(COMMANDS_DIR, "apply.ts"),
  completions: join(COMMANDS_DIR, "completions.ts"),
  destroy: join(COMMANDS_DIR, "destroy.ts"),
  doctor: join(COMMANDS_DIR, "doctor.ts"),
  drift: join(COMMANDS_DIR, "drift.ts"),
  init: join(COMMANDS_DIR, "init.ts"),
  list: join(COMMANDS_DIR, "list.ts"),
  optimize: join(COMMANDS_DIR, "optimize.ts"),
  plan: join(COMMANDS_DIR, "plan.ts"),
  reconcile: join(COMMANDS_DIR, "reconcile.ts"),
  setup: join(COMMANDS_DIR, "setup.ts"),
  status: join(COMMANDS_DIR, "status.ts"),
  version: join(COMMANDS_DIR, "version.ts"),
};

function parseCommanderOptions(source: string): Set<string> {
  const flags = new Set<string>();
  const optionRegex = /\.option\s*\(\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = optionRegex.exec(source)) !== null) {
    const spec = match[1]!;
    const tokens = spec.split(",").map((t) => t.trim());
    for (const t of tokens) {
      const long = /^--([A-Za-z][A-Za-z0-9-]*)/.exec(t);
      if (!long) continue;
      const name = long[1]!;
      flags.add(`--${name}`);
      if (name.startsWith("no-")) {
        flags.add(`--${name.slice(3)}`);
      } else {
        flags.add(`--no-${name}`);
      }
    }
  }
  return flags;
}

function buildKnownFlags(): {
  perCommand: Record<string, Set<string>>;
  global: Set<string>;
  commandNames: Set<string>;
} {
  const entrySrc = readFileSync(CLI_ENTRY, "utf8");
  const global = parseCommanderOptions(entrySrc);
  for (const builtin of ["--help", "--version"]) global.add(builtin);

  const perCommand: Record<string, Set<string>> = {};
  for (const [cmd, file] of Object.entries(SUBCOMMAND_FILES)) {
    try {
      const src = readFileSync(file, "utf8");
      const own = parseCommanderOptions(src);
      for (const g of global) own.add(g);
      own.add("--help");
      perCommand[cmd] = own;
    } catch {
      perCommand[cmd] = new Set(global);
    }
  }
  return {
    perCommand,
    global,
    commandNames: new Set(Object.keys(SUBCOMMAND_FILES)),
  };
}

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (EXCLUDE_DIR_PATTERNS.some((p) => p.test(full + "/"))) continue;
        walk(full);
        continue;
      }
      if (!full.endsWith(".ts")) continue;
      if (EXCLUDE_FILE_SUFFIXES.some((s) => full.endsWith(s))) continue;
      if (EXCLUDE_DIR_PATTERNS.some((p) => p.test(full))) continue;
      out.push(full);
    }
  };
  walk(root);
  return out;
}

interface EmittedTriple {
  command: string;
  flag: string;
  file: string;
  line: number;
  snippet: string;
}

function scanFileForTriples(
  file: string,
  commandNames: Set<string>,
): EmittedTriple[] {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const out: EmittedTriple[] = [];
  // Post-Story-108-A-07: noun-grouped CLI emits `assignee <group> <leaf>
  // --<flag>` where `<group>` is one of `infra`/`admin`/`dev`. The
  // optional `(?:infra|admin|dev)\s+` prefix is non-capturing so the
  // existing capture-group indices (`m[1]` = leaf cmd, `m[3]` = flag)
  // stay stable. Pre-migration call-sites that still emit the flat form
  // (`assignee plan --json`) remain matched as well — the prefix is
  // optional.
  const tripleRegex =
    /\bassignee\s+(?:(?:infra|admin|dev)\s+)?([a-z][a-z-]*)((?:[^"`\n]){0,200}?)(--[A-Za-z][A-Za-z0-9-]*)/g;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    tripleRegex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = tripleRegex.exec(line)) !== null) {
      const command = m[1]!;
      const flag = m[3]!;
      if (!commandNames.has(command)) continue;
      out.push({
        command,
        flag,
        file,
        line: i + 1,
        snippet: line.trim().slice(0, 180),
      });
    }
  }
  return out;
}

/**
 * Known-drift allowlist — entries here are references to flags that
 * were removed (or never existed) in call-sites the Wave 3.a fixer
 * does NOT own. Scheduled for removal in Wave 3.b along with the
 * source-string fix. The allowlist is reviewed every wave; the final
 * wave MUST empty it so the guard runs fully strict in long-term CI.
 */
const KNOWN_WAVE_3B_DRIFTS: ReadonlySet<string> = new Set([
  // `destroy --all` was removed in Story 50-3. Docstring comment in
  // apps/cli/src/services/iam-role-inventory.ts still references it.
  "destroy --all",
]);

function tripleKey(t: { command: string; flag: string }): string {
  return `${t.command} ${t.flag}`;
}

const KNOWN = buildKnownFlags();
const SCAN_ROOTS = [CLI_SRC, CORE_SRC];
const SOURCE_FILES = SCAN_ROOTS.flatMap((r) => listSourceFiles(r));
const ALL_TRIPLES: EmittedTriple[] = SOURCE_FILES.flatMap((f) =>
  scanFileForTriples(f, KNOWN.commandNames),
);

describe("help-hints flag-existence drift guard (Epic 92 wave 3.a)", () => {
  it("static parser extracts at least one option for every known subcommand", () => {
    for (const cmd of KNOWN.commandNames) {
      if (cmd === "completions" || cmd === "version") continue;
      const flags = KNOWN.perCommand[cmd];
      expect(flags, `parser failed for ${cmd}`).toBeDefined();
      expect(
        flags!.size,
        `expected at least one parsed option for ${cmd}`,
      ).toBeGreaterThan(0);
    }
  });

  it("source scan discovers at least one emitted `assignee <cmd> --<flag>` triple", () => {
    expect(ALL_TRIPLES.length).toBeGreaterThan(10);
  });

  it("every emitted `assignee <cmd> --<flag>` triple references a real Commander option", () => {
    const failures: string[] = [];
    const allowlistedHits: string[] = [];
    for (const t of ALL_TRIPLES) {
      const known = KNOWN.perCommand[t.command];
      if (!known) {
        failures.push(
          `Unknown command "${t.command}" referenced at ${relative(
            REPO_ROOT,
            t.file,
          )}:${t.line} (${t.snippet})`,
        );
        continue;
      }
      if (known.has(t.flag)) continue;
      const key = tripleKey(t);
      if (KNOWN_WAVE_3B_DRIFTS.has(key)) {
        allowlistedHits.push(
          `${key}  (emitted at ${relative(REPO_ROOT, t.file)}:${t.line})`,
        );
        continue;
      }
      failures.push(
        `${key}  (emitted at ${relative(REPO_ROOT, t.file)}:${t.line})  — snippet: ${t.snippet}`,
      );
    }
    const unique = Array.from(new Set(failures)).sort();
    expect(
      unique,
      `Emitted strings reference nonexistent Commander flags. ` +
        `Each entry is a (cmd, flag) pair that the matching subcommand ` +
        `does NOT register. Either add the option to the Commander ` +
        `definition, or fix the string to reference the real flag.`,
    ).toEqual([]);

    if (allowlistedHits.length > 0) {
      /* eslint-disable no-console */
      console.warn(
        "[help-hints-flag-existence] Wave-3.b backlog:\n" +
          Array.from(new Set(allowlistedHits)).sort().join("\n"),
      );
      /* eslint-enable no-console */
    }
  });

  it("KNOWN_WAVE_3B_DRIFTS allowlist has no stale entries", () => {
    const emittedKeys = new Set(ALL_TRIPLES.map((t) => tripleKey(t)));
    const stale: string[] = [];
    for (const key of KNOWN_WAVE_3B_DRIFTS) {
      if (!emittedKeys.has(key)) stale.push(key);
    }
    expect(
      stale,
      "KNOWN_WAVE_3B_DRIFTS contains entries that are no longer emitted " +
        "anywhere in the tree — delete them to keep the allowlist minimal.",
    ).toEqual([]);
  });
});
