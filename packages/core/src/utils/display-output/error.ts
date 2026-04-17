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
  if (process.stderr.isTTY) {
    process.stderr.write(chalk.red(`\u2716 Error: ${message}\n`));
    if (context?.why) {
      process.stderr.write(chalk.yellow(`  Why: ${context.why}\n`));
    }
    if (hint) {
      process.stderr.write(chalk.green(`  How to Fix: ${hint}\n`));
    }
  } else {
    process.stderr.write(`[ERROR] ${message}\n`);
    if (context?.why) {
      process.stderr.write(`[CONTEXT] ${context.why}\n`);
    }
    if (hint) {
      process.stderr.write(`[FIX] ${hint}\n`);
    }
  }
}
