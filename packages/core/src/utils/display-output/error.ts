/**
 * Structured error renderer — WHAT / WHY / HOW-TO-FIX.
 * @see Story 18.3 — Error Message Quality Audit
 */
import chalk from "chalk";
import { stopSpinner } from "./spinner.js";

/**
 * Renders an error message to stderr with structured WHAT / WHY / HOW-TO-FIX format.
 *
 * Overloads:
 * 1. renderError(message, hint?) — legacy format (backward-compatible)
 * 2. renderError(message, hint?, context?) — 3-part structured format
 */
export function renderError(
  message: string,
  hint?: string,
  context?: { why?: string },
): void {
  stopSpinner();
  // Epic 92 u.e (D-31): dedup CONTEXT when it would be a verbatim
  // restatement of the headline message. The list command's
  // LIST_ERROR path surfaces `err.message` as both `message` and
  // `context.why`, which produced output like:
  //   [ERROR] Failed to list managed resources.
  //   [CONTEXT] Failed to list managed resources.
  //   [FIX] Check your AWS credentials and try again.
  // The CONTEXT line adds no information when it equals the ERROR
  // line — comparing after trimming whitespace is intentional so
  // stray trailing spaces don't defeat the dedup.
  //
  // Story 94-R7 (D-10): strengthen the dedup to cover the
  // header-plus-details pattern — `context.why` begins with the
  // headline followed by a blank line, then carries the useful
  // detail body (registry grid, structured hint, etc.). Previously
  // the headline was echoed twice: once as `[ERROR] <headline>` and
  // once as the first line of `[CONTEXT] <headline>\n\n<detail>`.
  // We now strip the redundant `<headline>\n\n` prefix so CONTEXT
  // renders only the new information. If the ENTIRE `why` is just
  // the headline, we skip CONTEXT wholesale (D-31 case).
  const rawWhy = context?.why;
  const why = rawWhy?.trim();
  const headline = message.trim();
  let renderedWhy: string | undefined;
  if (why && why !== headline) {
    if (rawWhy && rawWhy.trimStart().startsWith(headline)) {
      // Strip the redundant headline prefix (plus any immediately
      // following whitespace/blank line). If the remainder is empty
      // we fall through to the D-31 path and hide CONTEXT entirely.
      const startIdx = rawWhy.indexOf(headline);
      const tail = rawWhy
        .slice(startIdx + headline.length)
        .replace(/^\s*\n/, "") // drop a single blank line separator
        .replace(/^\s+/, ""); // then drop leading whitespace
      renderedWhy = tail.length > 0 ? tail : undefined;
    } else {
      renderedWhy = context!.why;
    }
  }
  const showContext = renderedWhy !== undefined;
  if (process.stderr.isTTY) {
    process.stderr.write(chalk.red(`\u2716 Error: ${message}\n`));
    if (showContext) {
      process.stderr.write(chalk.yellow(`  Why: ${renderedWhy}\n`));
    }
    if (hint) {
      process.stderr.write(chalk.green(`  How to Fix: ${hint}\n`));
    }
  } else {
    process.stderr.write(`[ERROR] ${message}\n`);
    if (showContext) {
      process.stderr.write(`[CONTEXT] ${renderedWhy}\n`);
    }
    if (hint) {
      process.stderr.write(`[FIX] ${hint}\n`);
    }
  }
}
