/**
 * Self-update UX wrapper around the `update-notifier` npm package.
 *
 * When Assignee ships on the public npm registry, users who installed
 * globally (`npm i -g assignee`) should see a non-intrusive banner when
 * a newer version is available. We use the canonical `update-notifier`
 * package (Yeoman / Sindre Sorhus) that every major CLI tool relies on.
 *
 * Design constraints:
 *
 * - **No-op pre-publish.** While `apps/cli/package.json` stays
 *   `"private": true`, the npm registry returns 404 for lookups; the
 *   underlying library silently returns and no banner renders.
 * - **Silenced in non-interactive contexts.** CI logs, piped stdout,
 *   and machine-readable output (`--json` / `-o json`) must stay
 *   pristine for downstream parsers.
 * - **Explicit opt-out.** `ASSIGNEE_NO_UPDATE_CHECK=1` short-circuits
 *   the check entirely (useful for corporate network restrictions).
 * - **Error swallow.** The notifier is UX polish only — registry
 *   timeouts, malformed `package.json`, or library bugs must never
 *   surface as a hard CLI failure. All throws are caught and ignored.
 *
 * @see Wave H1 — L9-MED H6 self-update UX
 */

// `update-notifier@7.x` is pure-ESM and ships no types;
// `@types/update-notifier` only covers v6. Rather than adding an
// ambient `.d.ts` (which is out of Wave H1's exclusive scope), we
// import the module through a typed re-cast that narrowly describes
// the surface we actually use. All other access goes through
// well-typed locals — no `any` escapes this module.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — untyped pure-ESM package; surface captured in
// UpdateNotifierFactory below.
import updateNotifierImpl from "update-notifier";

/** Minimal package shape required by the underlying library. */
export interface NotifierPkg {
  name: string;
  version: string;
}

/** Narrow callable surface we consume from the package. */
interface NotifierHandle {
  notify(options?: { defer?: boolean; isGlobal?: boolean }): unknown;
}
type UpdateNotifierFactory = (settings: {
  pkg: NotifierPkg;
  updateCheckInterval?: number;
}) => NotifierHandle;

const updateNotifier = updateNotifierImpl as UpdateNotifierFactory;

/**
 * Return true when the update-check must be silenced.
 *
 * Exported for unit tests — production code calls {@link checkForUpdates}
 * which already consults this predicate.
 */
export function shouldSuppressUpdateCheck(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTTY: boolean = Boolean(process.stdout.isTTY),
): boolean {
  // Explicit opt-out wins. Bracket access required by
  // `noPropertyAccessFromIndexSignature` in the shared tsconfig.
  if (env["ASSIGNEE_NO_UPDATE_CHECK"] === "1") {
    return true;
  }

  // CI detection — GitHub Actions, GitLab, CircleCI, Jenkins, Buildkite
  // all export CI=true (or similar truthy value) by convention.
  const ci = env["CI"];
  if (ci && ci !== "" && ci !== "0" && ci !== "false") {
    return true;
  }

  // Piped / redirected stdout — don't pollute machine-readable streams.
  if (!stdoutIsTTY) {
    return true;
  }

  // Machine-readable flags — preserve parseable JSON output.
  // Check the tokenized argv (not a joined string) so `--jsonify` or
  // `--output-json-path` never match accidentally.
  for (const token of argv) {
    if (
      token === "--json" ||
      token === "-o=json" ||
      token === "--output=json"
    ) {
      return true;
    }
  }

  // Two-token form: `-o json` or `--output json`.
  for (let i = 0; i < argv.length - 1; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === "-o" || flag === "--output") && value === "json") {
      return true;
    }
  }

  return false;
}

/**
 * Kick off an async update check and, if a newer version is available
 * on the next invocation, render a single-line banner to stderr via
 * the library's `.notify()` helper.
 *
 * Safe to call unconditionally at CLI startup: it returns synchronously
 * after scheduling the background check, and any error is swallowed.
 *
 * @param pkg - The local package descriptor (name + version) read from
 *              `apps/cli/package.json`.
 * @param argv - Optional override for the process argv (tests inject).
 * @param env - Optional override for process.env (tests inject).
 * @param stdoutIsTTY - Optional override for TTY detection (tests inject).
 */
export function checkForUpdates(
  pkg: NotifierPkg,
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTTY: boolean = Boolean(process.stdout.isTTY),
): void {
  try {
    if (shouldSuppressUpdateCheck(argv, env, stdoutIsTTY)) {
      return;
    }

    // One check per 24h — the library persists the result under
    // `~/.config/configstore/update-notifier-<pkg>.json`, so this is
    // cheap across invocations.
    const notifier = updateNotifier({
      pkg,
      updateCheckInterval: 1000 * 60 * 60 * 24,
    });

    // `.notify()` renders a boxed banner to stderr only when the
    // background fetch has observed a newer version. On first run
    // (or when the registry is unreachable) it is a no-op.
    notifier.notify({ defer: true, isGlobal: true });
  } catch {
    // Notifier is UX polish — never block the CLI on a failure here.
    // Swallowing covers: registry unreachable, malformed package.json,
    // library internal errors, configstore write failures, etc.
  }
}
