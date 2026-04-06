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
 * Detect what credentials are available in the environment.
 * Returns a status string for first-run guidance.
 */
export function detectCredentialStatus(): {
  status: "operator" | "standard" | "profile" | "none";
  hint: string;
} {
  const hasOperator =
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] &&
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
  if (hasOperator) {
    return {
      status: "operator",
      hint: "✓ Assignee credentials configured (ASSIGNEE_OPERATOR_*)",
    };
  }

  const hasStandard =
    process.env["AWS_ACCESS_KEY_ID"] && process.env["AWS_SECRET_ACCESS_KEY"];
  if (hasStandard) {
    return {
      status: "standard",
      hint: "✓ Standard AWS credentials detected (AWS_ACCESS_KEY_ID) — will auto-promote",
    };
  }

  if (process.env["AWS_PROFILE"]) {
    return {
      status: "profile",
      hint: `⚠  AWS_PROFILE=${process.env["AWS_PROFILE"]} detected but not supported directly — export AWS_ACCESS_KEY_ID or run \`assignee setup\``,
    };
  }

  return {
    status: "none",
    hint: "❌ No AWS credentials detected",
  };
}

/**
 * Display first-run welcome message to stderr (so stdout stays clean for plan output).
 * Provides guided next-steps based on detected credential status.
 *
 * @param version - CLI version string
 */
export function showFirstRunWelcome(version: string): void {
  if (!process.stderr.isTTY) {
    // Non-TTY: minimal output for CI/pipes
    process.stderr.write(
      `Assignee v${version} — first run, auto-detecting environment...\n`,
    );
    return;
  }

  const creds = detectCredentialStatus();
  const lines: string[] = [
    "",
    `\u001B[36m✦ Welcome to Assignee.ai v${version}\u001B[0m`,
    "\u001B[90m  AI-Native Cloud Operator — natural language → AWS infrastructure\u001B[0m",
    "",
    `  ${creds.hint}`,
    "",
  ];

  if (creds.status === "none") {
    lines.push(
      "\u001B[33m  Get started in 2 minutes:\u001B[0m",
      "",
      "  \u001B[1m1.\u001B[0m Set AWS credentials (easiest):",
      "       \u001B[36mexport AWS_ACCESS_KEY_ID=<your-key>\u001B[0m",
      "       \u001B[36mexport AWS_SECRET_ACCESS_KEY=<your-secret>\u001B[0m",
      "",
      "  \u001B[1m2.\u001B[0m \u001B[1mOr\u001B[0m create least-privilege IAM users (recommended):",
      "       \u001B[36massignee setup\u001B[0m",
      "",
      "  \u001B[1m3.\u001B[0m Try your first plan:",
      '       \u001B[36massignee plan "Create an S3 bucket for my static site"\u001B[0m',
      "",
      "\u001B[90m  More: https://github.com/SergSlon/assignee-ai\u001B[0m",
      "",
    );
  } else if (creds.status === "profile") {
    lines.push(
      "\u001B[33m  Next steps:\u001B[0m",
      "",
      "  • Export your AWS credentials directly:",
      "       \u001B[36mexport AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...\u001B[0m",
      "",
      "  • Or run `assignee setup` to create least-privilege IAM users",
      "",
    );
  } else {
    // operator or standard — credentials work, just show next step
    lines.push(
      "\u001B[90m  Try:\u001B[0m",
      '  \u001B[36m  assignee plan "Create an S3 bucket for my static site"\u001B[0m',
      "",
    );
  }

  process.stderr.write(lines.join("\n"));
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
