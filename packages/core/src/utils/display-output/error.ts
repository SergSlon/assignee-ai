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
  const why = context?.why?.trim();
  const headline = message.trim();
  const showContext = !!why && why !== headline;
  if (process.stderr.isTTY) {
    process.stderr.write(chalk.red(`\u2716 Error: ${message}\n`));
    if (showContext) {
      process.stderr.write(chalk.yellow(`  Why: ${context!.why}\n`));
    }
    if (hint) {
      process.stderr.write(chalk.green(`  How to Fix: ${hint}\n`));
    }
  } else {
    process.stderr.write(`[ERROR] ${message}\n`);
    if (showContext) {
      process.stderr.write(`[CONTEXT] ${context!.why}\n`);
    }
    if (hint) {
      process.stderr.write(`[FIX] ${hint}\n`);
    }
  }
}
