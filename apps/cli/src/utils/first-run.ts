/**
 * First-run detection and graceful bootstrap for npx quick start.
 * Detects when no ~/.assignee/ directory exists and provides
 * a smooth first-run experience.
 *
 * Story 50-2: raw ANSI escape codes (\u001B[...) were replaced with
 * `chalk` calls for consistency with the rest of the CLI (display-plan,
 * display-prompts, etc.). chalk@5 honors `NO_COLOR` natively — when
 * `NO_COLOR` is set the output degrades to plain text automatically.
 *
 * @see Story 29.6 — Single-Command Quick Start (npx)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import chalk from "chalk";
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
      hint: "[OK] Assignee credentials configured (ASSIGNEE_OPERATOR_*)",
    };
  }

  const hasStandard =
    process.env["AWS_ACCESS_KEY_ID"] && process.env["AWS_SECRET_ACCESS_KEY"];
  if (hasStandard) {
    return {
      status: "standard",
      hint: "[OK] Standard AWS credentials detected (AWS_ACCESS_KEY_ID) - will auto-promote",
    };
  }

  if (process.env["AWS_PROFILE"]) {
    return {
      status: "profile",
      hint: `[OK] AWS_PROFILE=${process.env["AWS_PROFILE"]} detected -- named profile will be used via the standard credential chain`,
    };
  }

  return {
    status: "none",
    hint: "[NONE] No AWS credentials detected",
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
    // Non-TTY: minimal ASCII-only output for CI/pipes (no Unicode glyphs)
    process.stderr.write(
      `Assignee v${version} - first run, auto-detecting environment...\n`,
    );
    return;
  }

  const creds = detectCredentialStatus();
  const lines: string[] = [
    "",
    chalk.cyan(`✦ Welcome to Assignee.ai v${version}`),
    chalk.gray(
      "  AI-Native Cloud Operator — natural language → AWS infrastructure",
    ),
    "",
    `  ${creds.hint}`,
    "",
  ];

  if (creds.status === "none") {
    lines.push(
      chalk.yellow("  Get started in 2 minutes:"),
      "",
      `  ${chalk.bold("1.")} Set AWS credentials (easiest):`,
      chalk.gray("       bash/zsh:"),
      `       ${chalk.cyan("export AWS_ACCESS_KEY_ID=<your-key>")}`,
      `       ${chalk.cyan("export AWS_SECRET_ACCESS_KEY=<your-secret>")}`,
      chalk.gray("       PowerShell:"),
      `       ${chalk.cyan("$Env:AWS_ACCESS_KEY_ID='<your-key>'")}`,
      `       ${chalk.cyan("$Env:AWS_SECRET_ACCESS_KEY='<your-secret>'")}`,
      "",
      `  ${chalk.bold("2.")} ${chalk.bold("Or")} create least-privilege IAM users (recommended):`,
      `       ${chalk.cyan("assignee setup")}`,
      "",
      `  ${chalk.bold("3.")} Try your first plan:`,
      `       ${chalk.cyan('assignee plan "Create an S3 bucket for my static site"')}`,
      "",
      chalk.gray("  More: https://github.com/SergSlon/assignee-ai"),
      "",
    );
  } else if (creds.status === "profile") {
    lines.push(
      chalk.yellow("  Next steps:"),
      "",
      "  • Export your AWS credentials directly:",
      chalk.gray("       bash/zsh:"),
      `       ${chalk.cyan("export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...")}`,
      chalk.gray("       PowerShell:"),
      `       ${chalk.cyan("$Env:AWS_ACCESS_KEY_ID='...'; $Env:AWS_SECRET_ACCESS_KEY='...'")}`,
      "",
      "  • Or run `assignee setup` to create least-privilege IAM users",
      "",
    );
  } else {
    // operator or standard — credentials work, just show next step
    lines.push(
      chalk.gray("  Try:"),
      `  ${chalk.cyan('  assignee plan "Create an S3 bucket for my static site"')}`,
      "",
    );
  }

  // Discoverability hints for first-time users. Story 50-3 removed the
  // dedicated `patterns` / `types` listing commands — their content is
  // folded into `assignee plan --help`, so that is the right pointer.
  lines.push(
    chalk.gray("  Discover what assignee can build:"),
    `  ${chalk.cyan("  assignee plan --help")}    ${chalk.gray("# list supported resource types + compound patterns")}`,
    "",
  );

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
