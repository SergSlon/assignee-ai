/**
 * First-run detection and graceful bootstrap for npx quick start.
 * Detects when no ~/.assignee/ directory exists and provides
 * a smooth first-run experience.
 *
 * @see Story 29.6 — Single-Command Quick Start (npx)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ASSIGNEE_DIR } from "../config/constants.js";

/** Path to the assignee state directory. */
export const ASSIGNEE_HOME = path.join(os.homedir(), ASSIGNEE_DIR);

/**
 * Check if this is a first run (no ~/.assignee/ directory).
 */
export function isFirstRun(): boolean {
  try {
    return !fs.existsSync(ASSIGNEE_HOME);
  } catch {
    return true;
  }
}

/**
 * Ensure the ~/.assignee/ directory exists.
 * Creates it with minimal defaults on first run.
 */
export function ensureAssigneeHome(): void {
  try {
    fs.mkdirSync(path.join(ASSIGNEE_HOME, "memory"), { recursive: true });
  } catch {
    // Non-fatal — may fail on read-only fs
  }
}

/**
 * Display first-run welcome message to stderr (so stdout stays clean for plan output).
 *
 * @param version - CLI version string
 */
export function showFirstRunWelcome(version: string): void {
  if (process.stderr.isTTY) {
    process.stderr.write(
      `Assignee v${version} — first run, auto-detecting environment...\n`,
    );
  }
}

/**
 * Bootstrap the first-run experience.
 * Called from index.ts before command parsing.
 *
 * @param version - CLI version string
 * @returns true if this was a first run
 */
export function bootstrapFirstRun(version: string): boolean {
  if (!isFirstRun()) return false;

  showFirstRunWelcome(version);
  ensureAssigneeHome();
  return true;
}
