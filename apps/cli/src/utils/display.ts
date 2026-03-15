/**
 * Terminal display layer for Assignee.ai CLI (Story 1-8, AC9).
 * Owns ALL terminal formatting — no inline chalk in command files.
 *
 * Non-TTY fallback: plain text without ANSI when !process.stdout.isTTY (CI/pipes).
 */

import * as clack from "@clack/prompts";
import chalk from "chalk";
import boxen from "boxen";
import { AWS_REGION, BEDROCK_MODEL_ID } from "../config/constants.js";

/** Returns the region label for the plan box.
 *  Cross-regional inference profiles (us.*, eu.*, ap.*) are annotated. */
function regionLabel(): string {
  const crossRegionalPrefix = BEDROCK_MODEL_ID.match(/^(us|eu|ap)\./)?.[1];
  return crossRegionalPrefix
    ? `${AWS_REGION} (cross-regional inference: ${crossRegionalPrefix}.*)`
    : AWS_REGION;
}

/** Minimal state shape needed for rendering — avoids circular imports with graph.ts */
export interface RenderableState {
  resourceType: string;
  desiredState?: Record<string, unknown>;
  estimatedMonthlyCost?: string;
  runId: string;
  resourceArn?: string;
  executionMode?: string;
}

// ── Spinner (AC2) ────────────────────────────────────────────────────────────

let _spinner: ReturnType<typeof clack.spinner> | null = null;

export function startSpinner(label: string): void {
  if (process.stdout.isTTY) {
    _spinner = clack.spinner();
    _spinner.start(label);
  } else {
    process.stdout.write(`${label}...\n`);
  }
}

export function updateSpinner(label: string): void {
  if (_spinner) {
    _spinner.message(label);
  } else if (!process.stdout.isTTY) {
    process.stdout.write(`${label}...\n`);
  }
}

export function stopSpinner(message?: string): void {
  if (_spinner) {
    _spinner.stop(message);
    _spinner = null;
  }
}

// ── Core render functions ─────────────────────────────────────────────────────

export function renderIntro(): void {
  if (process.stdout.isTTY) {
    clack.intro(chalk.cyan.bold("✦ Assignee.ai — AI-Native Cloud Operator"));
  } else {
    process.stdout.write("✦ Assignee.ai — AI-Native Cloud Operator\n");
  }
}

export function renderPlanBox(state: RenderableState): void {
  const content = [
    `Resource Type:   ${state.resourceType}`,
    `Region:          ${regionLabel()}`,
    `Config:          ${JSON.stringify(state.desiredState, null, 2)}`,
    `Estimated Cost:  ${state.estimatedMonthlyCost ?? "N/A"}`,
    `Run ID:          ${state.runId}`,
  ].join("\n");

  if (process.stdout.isTTY) {
    process.stdout.write(
      boxen(content, {
        title: "Plan",
        titleAlignment: "center",
        borderColor: "cyan",
        padding: 1,
      }) + "\n",
    );
  } else {
    process.stdout.write(`=== Plan ===\n${content}\n============\n`);
  }
}

export function renderError(message: string, hint?: string): void {
  if (process.stderr.isTTY) {
    process.stderr.write(chalk.red(`✖ Error: ${message}\n`));
    if (hint) {
      process.stderr.write(chalk.dim(`  How to Fix: ${hint}\n`));
    }
  } else {
    process.stderr.write(`Error: ${message}\n`);
    if (hint) {
      process.stderr.write(`How to Fix: ${hint}\n`);
    }
  }
}

export async function renderHitlConfirm(
  state: RenderableState,
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // Non-TTY: safe default is decline
    return false;
  }

  const result = await clack.confirm({
    message: `Apply this plan to create ${state.resourceType}? [y/N]`,
    initialValue: false,
  });

  if (clack.isCancel(result)) return false;
  return result === true;
}

export function renderApplySuccess(state: RenderableState): void {
  if (process.stdout.isTTY) {
    process.stdout.write(chalk.green("✅ Resource created successfully!\n"));
    if (state.resourceArn) {
      process.stdout.write(chalk.green(`   ARN: ${state.resourceArn}\n`));
    }
    process.stdout.write(chalk.dim(`   Run ID: ${state.runId}\n`));
  } else {
    process.stdout.write(
      `SUCCESS\nARN: ${state.resourceArn ?? "N/A"}\nRun ID: ${state.runId}\n`,
    );
  }
}

export function renderOutro(success: boolean): void {
  if (process.stdout.isTTY) {
    clack.outro(
      success
        ? chalk.green("✅ Operation completed successfully")
        : chalk.red("❌ Operation failed"),
    );
  } else {
    process.stdout.write(
      success ? "Operation completed successfully\n" : "Operation failed\n",
    );
  }
}
