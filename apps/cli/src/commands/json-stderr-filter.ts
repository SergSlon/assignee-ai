/**
 * JSON-mode stderr filter — Epic 96 Wave 3 N4 (D-04).
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
 * begins with one of the `renderError` prefixes is dropped. Structured
 * log lines (`{"ts":...,"level":"info",...}`) and any other stderr
 * writes pass through unchanged. Stderr is NOT blackholed — the fix is
 * a surgical prefix filter, not a nuke.
 *
 * Scope: imported by `apply.ts` / `destroy.ts` / `reconcile.ts` — the
 * three commands cli-fixer owns. Other JSON-mode commands (plan / list
 * / drift / status) own their own wrappers and can adopt this helper in
 * a follow-up wave; this commit fixes the three within-scope surfaces.
 */

/**
 * Prefixes emitted by `renderError` that identify a human-readable
 * error block. Two flavours are supported because the renderer branches
 * on `process.stderr.isTTY`:
 *   - non-TTY: `[ERROR] ...\n[CONTEXT] ...\n[FIX] ...\n`
 *   - TTY: `\u2716 Error: ...\n  Why: ...\n  How to Fix: ...\n`
 *     (wrapped in ANSI colour codes by chalk, so we scan after the
 *     first non-escape character).
 *
 * Kept as a readonly string[] so the matcher runs a tight loop without
 * a regex engine per write.
 */
const HUMAN_ERROR_PREFIXES: readonly string[] = [
  "[ERROR] ",
  "[CONTEXT] ",
  "[FIX] ",
  "\u2716 Error: ",
  "  Why: ",
  "  How to Fix: ",
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
