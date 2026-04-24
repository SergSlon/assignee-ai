/**
 * `--json` / `--output <format>` normalisation helper.
 *
 * Closes Epic 97 B-07 + D-16: every command accepts BOTH `--json`
 * (shorthand boolean) AND `-o, --output <format>` (string enum). The
 * two flags normalise into a single `jsonMode` boolean so the command
 * body doesn't have to branch on two shapes.
 *
 * Precedence (matches pre-N3 behaviour in apply/plan/destroy/reconcile):
 *   1. `--output json` wins when explicitly set.
 *   2. `--output <anything>` other than "json" → text mode.
 *   3. If `--output` is undefined or "text" and `--json` is true →
 *      JSON mode (backfill shorthand into `output`).
 *
 * Keep this helper POP-free (no side effects): the caller mutates
 * `opts` if it wants the backfill so subsequent reads of `opts.output`
 * agree with the return value.
 */

/** Narrow shape every command's options object satisfies. */
export interface JsonFlagOptions {
  json?: boolean;
  output?: string;
}

/**
 * When ASSIGNEE_DEMO_REDACT_ACCOUNT=1, replace every 12-digit AWS account ID
 * that appears in an ARN-like position (followed by ":") with "************".
 * Only affects CLI display output — state files and provision logs keep real ARNs.
 */
export function redactAccountIdIfDemoMode(text: string): string {
  if (process.env["ASSIGNEE_DEMO_REDACT_ACCOUNT"] !== "1") return text;
  return text.replace(/\d{12}(?=:)/g, "************");
}

/**
 * Collapse `--json` + `-o, --output <format>` into a single
 * jsonMode boolean. Mutates the passed options object so
 * `opts.output` reflects the normalised value ("json" when jsonMode,
 * caller-provided value otherwise).
 */
export function resolveJsonMode<T extends JsonFlagOptions>(opts: T): boolean {
  if (opts.output === "json") return true;
  if (
    opts.json === true &&
    (opts.output === undefined || opts.output === "text")
  ) {
    opts.output = "json";
    return true;
  }
  return false;
}
