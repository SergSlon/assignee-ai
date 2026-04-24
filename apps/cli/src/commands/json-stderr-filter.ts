/**
 * JSON-mode stderr filter — Epic 96 Wave 3 N4 (D-04), extended by
 * Epic 98 e98.W5.N3 to cover every human-formatted leak source
 * identified in Epic 97 slice D (D-01, D-02, D-12, D-23) plus the
 * cross-command surface (`--json` every command per B-07 / D-16).
 *
 * When a command runs with `--output json` / `--json`, stdout carries a
 * single machine-readable envelope and stderr is supposed to remain
 * clean of duplicated human-readable error prose. The canonical
 * `renderError()` in `@assignee/core/utils/display-output/error.ts`
 * writes the same `code` / `message` / `hint` we emit on stdout as a
 * `[ERROR]` / `[CONTEXT]` / `[FIX]` block on stderr — that duplication
 * wastes scroll space in CI logs and confuses `jq | tee stderr.log`
 * pipelines that treat stderr as a structured log stream.
 *
 * The existing stdout suppressor (per-command) blackholes stdout and
 * flushes a single envelope on completion. This module mirrors the
 * pattern for stderr: while the filter is installed, any write that
 * begins with one of the prefixes below is dropped. Structured
 * log lines (`{"ts":...,"level":"info",...}`) and any other stderr
 * writes pass through unchanged. Stderr is NOT blackholed — the fix is
 * a surgical prefix filter, not a nuke.
 *
 * Scope: imported by ALL 9 command files (plan / apply / destroy /
 * reconcile / list / drift / status / doctor / optimize) so the JSON
 * contract is uniform across the CLI surface.
 */

/**
 * Prefixes that identify a human-readable line leaking onto stderr
 * while the command is in `--json` / `--output json` mode. Sources:
 *
 *   1. `renderError()` \u2014 two flavours because the renderer branches
 *      on `process.stderr.isTTY`:
 *        - non-TTY: `[ERROR] ...\n[CONTEXT] ...\n[FIX] ...\n`
 *        - TTY: `\u2716 Error: ...\n  Why: ...\n  How to Fix: ...\n`
 *          (wrapped in ANSI colour codes by chalk, stripped before match).
 *
 *   2. Bare `Error:` prose \u2014 Commander-style usage errors
 *      (`Error: Missing intent...`) and plain `throw new Error(...)`
 *      paths that print `Error: <msg>`. Closes D-01.
 *
 *   3. First-run banner \u2014 `Assignee v0.1.0 \u2014 first run, auto-detecting
 *      environment...`. Emitted once, on cold-start, regardless of
 *      output mode. Closes D-02.
 *
 *   4. Budget-exceeded WARN \u2014 `[assignee] WARNING: BUDGET EXCEEDED:
 *      ...` from `apps/cli/src/telemetry/timing.ts:checkTimingsAgainstBudgets`.
 *      Closes D-23.
 *
 *   5. Ambiguous-shorthand WARN \u2014 `Shorthand "<x>" resolved to ...`
 *      from `apps/cli/src/commands/resource-type-filter.ts:warnAmbiguousShorthandIfNeeded`.
 *      Closes D-12.
 *
 * Kept as a readonly string[] so the matcher runs a tight loop without
 * a regex engine per write. Prefixes are intentionally narrow \u2014 we do
 * NOT blackhole generic messages like "Warning:" or anything without
 * an identifying marker, so unrelated warnings still reach stderr.
 */
const HUMAN_ERROR_PREFIXES: readonly string[] = [
  "[ERROR] ",
  "[CONTEXT] ",
  "[FIX] ",
  "\u2716 Error: ",
  "  Why: ",
  "  How to Fix: ",
  // D-01: Commander-style usage errors + plain `Error:` prose.
  "Error: ",
  // D-02: First-run banner. `Assignee v0.1.0 \u2014 first run, ...` \u2014
  // matches on the "Assignee v" prefix so version bumps don't break
  // the filter (e.g. `Assignee v0.2.0`, `Assignee v1.0.0`).
  "Assignee v",
  // D-23: Budget-exceeded WARN emitted by
  // `apps/cli/src/telemetry/timing.ts`.
  "[assignee] WARNING: ",
  // D-12: Ambiguous-shorthand WARN emitted by
  // `apps/cli/src/commands/resource-type-filter.ts`.
  'Shorthand "',
  // Progress lines emitted every ~5 s during long scans. Human-readable
  // only; JSON mode must stay stdout-only (W5.N3 contract).
  "[INFO] ",
];

/**
 * Strip leading ANSI SGR escape sequences (`\u001b[<codes>m`) so the
 * matcher works whether chalk is active or not. The sequence is short
 * enough that a single regex slice beats parsing — at most a few bytes
 * per write.
 */
function stripLeadingAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/^(?:\x1b\[[0-9;]*m)+/, "");
}

/**
 * Test whether a chunk starts with one of the renderError prefixes
 * AFTER stripping any leading ANSI escape sequence. Writes that match
 * are dropped under JSON mode.
 */
function isHumanErrorPrefix(text: string): boolean {
  const stripped = stripLeadingAnsi(text);
  for (const prefix of HUMAN_ERROR_PREFIXES) {
    if (stripped.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Install a stderr filter that drops `renderError` writes while active.
 * Returns a `restore` callback the caller MUST invoke in a `finally`
 * block so the original `process.stderr.write` is put back even when
 * the command throws.
 *
 * When `enabled` is false (plaintext mode), the installer is a no-op
 * and returns a noop `restore` — callers don't have to branch.
 */
export function installJsonStderrFilter(enabled: boolean): {
  restore: () => void;
} {
  if (!enabled) {
    return { restore: () => {} };
  }
  // Capture the original by reference (NOT `.bind`) so `restore()`
  // puts back the same function identity any test spy may have
  // targeted. Mirrors the stdout suppressor contract.
  const originalWrite = process.stderr.write;

  process.stderr.write = ((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ): boolean => {
    const text =
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (isHumanErrorPrefix(text)) {
      // Invoke the write callback (if any) so the caller's
      // write-result contract is preserved — just as the stdout
      // suppressor does for dropped stdout writes.
      const cb = rest.find((r) => typeof r === "function") as
        | ((err?: Error | null) => void)
        | undefined;
      if (cb) cb();
      return true;
    }
    return (
      originalWrite as (this: NodeJS.WriteStream, ...args: unknown[]) => boolean
    ).call(process.stderr, chunk, ...rest);
  }) as typeof process.stderr.write;

  let restored = false;
  return {
    restore: (): void => {
      if (restored) return;
      process.stderr.write = originalWrite;
      restored = true;
    },
  };
}
