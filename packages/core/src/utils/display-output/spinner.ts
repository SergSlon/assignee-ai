/**
 * Clack spinner lifecycle helpers.
 * Owns the singleton clack spinner so callers never have to juggle the
 * handle — all renderers in display-output import `stopSpinner` from here
 * to guarantee the spinner is paused before they write.
 */
import * as clack from "@clack/prompts";

let _spinner: ReturnType<typeof clack.spinner> | null = null;

/**
 * F15 fix (2026-05-22): the spinner should be a no-op (or single line
 * fallback) in non-interactive contexts. Three signals collapse to the
 * same answer:
 *
 *   - `!process.stdout.isTTY` — output is a pipe, file, or non-TTY
 *     (CI logs, screen readers, PTY-replay tooling, redirected stdout).
 *   - `process.env.CI` is set — every major CI provider (GitHub
 *     Actions, GitLab, CircleCI, Buildkite) sets `CI=true`/`CI=1`.
 *     Honouring it follows the convention used by npm, pnpm, cargo,
 *     and most CLI tools.
 *   - `process.env.NO_PROGRESS` is set — explicit opt-out for users
 *     who want a clean log even on a TTY (terminal recording, etc.).
 *
 * Predicate is exported so direct `clack.spinner()` call sites
 * (parallel-enrichment, setup wizards) can adopt the same gate
 * incrementally.
 */
export function shouldShowSpinner(): boolean {
  if (!process.stdout.isTTY) return false;
  if (process.env["CI"]) return false;
  if (process.env["NO_PROGRESS"]) return false;
  return true;
}

export function startSpinner(label: string): void {
  if (shouldShowSpinner()) {
    _spinner = clack.spinner();
    _spinner.start(label);
  } else {
    process.stdout.write(`${label}...\n`);
  }
}

export function updateSpinner(label: string): void {
  if (_spinner) {
    _spinner.message(label);
  } else if (!shouldShowSpinner()) {
    process.stdout.write(`${label}...\n`);
  }
}

export function stopSpinner(message?: string): void {
  if (_spinner) {
    _spinner.stop(message);
    _spinner = null;
  }
}

process.on("exit", () => {
  if (_spinner) {
    try {
      _spinner.stop();
    } catch {
      /* ignore */
    }
  }
});
