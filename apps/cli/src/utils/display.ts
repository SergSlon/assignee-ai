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
import { AssigneeError } from "@assignee/core";
import type {
  ResourceField,
  ResolvedFieldConfig,
  ResourceResult,
  ArchitecturePattern,
  ResourceSpec,
  LlmPort,
} from "@assignee/core";
import type { BPFinding } from "@assignee/best-practices";
import type { SecurityFinding } from "../services/graph-state.js";
import type { FreeTierNote } from "./free-tier.js";
import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../constants/tools.js";
import { DOC_SECTION_TITLES } from "../constants/doc-sections.js";
import { unwrapMcpText } from "./mcp.js";
import { withTimeout } from "./timeout.js";
import { extractFirstUrl } from "./mcp-types.js";

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
  freeTierNote?: FreeTierNote;
  bpFindings?: BPFinding[];
  memoryHints?: string[];
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
  stopSpinner();

  // Story 18.10: Unified findings section (merged guardrails + best practices)
  const findingsLine = formatFindings(state.bpFindings);

  // Story 7.8: Free tier note line (optional, non-blocking)
  const freeTierLine = formatFreeTierNote(state.freeTierNote);

  // Story 19.3: Memory hints from provision history (optional)
  const memoryHintLines = formatMemoryHints(state.memoryHints);

  const content = [
    `Resource Type:   ${state.resourceType}`,
    `Region:          ${regionLabel()}`,
    `Config:          ${JSON.stringify(state.desiredState, null, 2)}`,
    `Estimated Cost:  ${state.estimatedMonthlyCost ?? "N/A"}`,
    ...(freeTierLine ? [freeTierLine] : []),
    ...(memoryHintLines ? [memoryHintLines] : []),
    findingsLine,
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

/**
 * Formats all findings (blocking + non-blocking) for display in the plan box.
 * Replaces the former separate formatGuardrailFindings and formatBPFindings.
 * TTY mode uses chalk coloring. Non-TTY mode uses plain text markers.
 *
 * @see Story 18.10
 */
export function formatFindings(findings: BPFinding[] | undefined): string {
  const items = findings ?? [];
  const isTTY = process.stdout.isTTY;

  if (items.length === 0) {
    return isTTY
      ? `Findings:        ${chalk.green("All checks passed")}`
      : "Findings:        PASS All checks passed";
  }

  const blocking = items.filter((f) => f.blocking);
  const critical = items.filter(
    (f) => !f.blocking && f.severity === "CRITICAL",
  );
  const high = items.filter((f) => f.severity === "HIGH" && !f.blocking);
  const medium = items.filter((f) => f.severity === "MEDIUM");
  const info = items.filter((f) => f.severity === "INFO");

  const summary = [
    blocking.length > 0 ? `${blocking.length} blocking` : null,
    critical.length > 0 ? `${critical.length} critical` : null,
    high.length > 0 ? `${high.length} high` : null,
    medium.length > 0 ? `${medium.length} medium` : null,
    info.length > 0 ? `${info.length} info` : null,
  ]
    .filter(Boolean)
    .join(", ");

  if (isTTY) {
    const lines = [
      `Findings:        ${summary}`,
      ...items.map((f) => {
        const hint = f.remediation ? ` (${f.remediation})` : "";
        if (f.blocking) return chalk.red(`  BLOCK  ${f.message}${hint}`);
        if (f.severity === "CRITICAL")
          return chalk.red(`  CRIT   ${f.message}${hint}`);
        if (f.severity === "HIGH")
          return chalk.red(`  HIGH   ${f.message}${hint}`);
        if (f.severity === "MEDIUM")
          return chalk.yellow(`  WARN   ${f.message}${hint}`);
        return chalk.blue(`  INFO   ${f.message}${hint}`);
      }),
    ];
    return lines.join("\n");
  }

  // Non-TTY: plain text without chalk
  const lines = [
    `Findings:        ${summary}`,
    ...items.map((f) => {
      const hint = f.remediation ? ` (${f.remediation})` : "";
      if (f.blocking) return `  [BLOCK] ${f.message}${hint}`;
      if (f.severity === "CRITICAL") return `  [CRITICAL] ${f.message}${hint}`;
      if (f.severity === "HIGH") return `  [HIGH] ${f.message}${hint}`;
      if (f.severity === "MEDIUM") return `  [MEDIUM] ${f.message}${hint}`;
      return `  [INFO] ${f.message}${hint}`;
    }),
  ];
  return lines.join("\n");
}

/**
 * Formats a free tier note for display in the plan box.
 * Returns null if no note is present.
 */
function formatFreeTierNote(note: FreeTierNote | undefined): string | null {
  if (!note) return null;
  const icon = note.type === "always_free" ? "\u2713" : "\u2139";
  return `Free Tier:       ${icon} ${note.message}`;
}

/**
 * Formats memory hints for display in the plan box (Story 19.3).
 * Returns null if no hints are present.
 */
function formatMemoryHints(hints: string[] | undefined): string | null {
  if (!hints || hints.length === 0) return null;
  const isTTY = process.stdout.isTTY;
  const lines = hints.map((h) =>
    isTTY ? chalk.dim(`Cost History:    ${h}`) : `Cost History:    ${h}`,
  );
  return lines.join("\n");
}

/**
 * Renders a compound provisioning plan as a dependency-ordered resource list.
 * Called by human_approval node when resourcePattern is set (compound intent).
 * Non-TTY fallback: plain text without ANSI/boxen (CI-safe).
 *
 * @param pattern - The detected architecture pattern
 * @param resourceQueue - Resources in provisioning order (from compound_dispatcher)
 * @param perResourceCosts - Optional map of resourceId → cost string from preflight_guard
 */
export function renderDependencyPlan(
  pattern: ArchitecturePattern,
  resourceQueue: ResourceSpec[],
  perResourceCosts?: Record<string, string>,
  bpFindings?: BPFinding[],
): void {
  stopSpinner();
  const lines: string[] = [
    `Pattern:  ${pattern.displayName}`,
    ``,
    `Will provision ${resourceQueue.length} resource${resourceQueue.length === 1 ? "" : "s"} in order:`,
    ``,
  ];

  resourceQueue.forEach((resource, index) => {
    const cost = perResourceCosts?.[resource.resourceId];
    lines.push(`  [${index + 1}] ${resource.resourceType}`);
    lines.push(`       ${resource.displayName}${cost ? `  (~${cost})` : ""}`);
    if (index < resourceQueue.length - 1) {
      lines.push(`       ↓`);
    }
  });

  // Compute total cost if any per-resource costs are available
  if (perResourceCosts) {
    const knownCosts = resourceQueue
      .map((r) => perResourceCosts[r.resourceId])
      .filter((c): c is string => Boolean(c) && c !== "N/A" && c !== "Free");
    if (knownCosts.length > 0) {
      lines.push(``);
      lines.push(`Estimated cost: ${knownCosts.join(" + ")} /month`);
      if (knownCosts.length < resourceQueue.length) {
        lines.push(`  (partial — not all resource costs estimated yet)`);
      }
    }
  }

  // Story 18.10: Unified findings summary for compound plans
  lines.push(``);
  lines.push(formatFindings(bpFindings));

  lines.push(``);
  lines.push(`Region:   ${regionLabel()}`);

  const content = lines.join("\n");

  if (process.stdout.isTTY) {
    process.stdout.write(
      boxen(content, {
        title: "Compound Provisioning Plan",
        titleAlignment: "left",
        borderColor: "cyan",
        padding: 1,
      }) + "\n",
    );
  } else {
    process.stdout.write(
      `=== Compound Provisioning Plan ===\n${content}\n==================================\n`,
    );
  }
}

/**
 * Renders an error message to stderr with structured WHAT / WHY / HOW-TO-FIX format.
 *
 * Overloads:
 * 1. renderError(message, hint?) — legacy format (backward-compatible)
 * 2. renderError(message, hint?, context?) — 3-part structured format
 *
 * @see Story 18.3 — Error Message Quality Audit
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

/**
 * Prompts user to approve a compound multi-resource provisioning plan.
 * Uses the same @clack/prompts confirm() as the single-resource renderHitlConfirm.
 * Non-TTY: safe default is decline.
 *
 * @param pattern - The architecture pattern for display context
 * @param resourceCount - Number of resources to be provisioned
 */
export async function renderHitlCompoundConfirm(
  pattern: ArchitecturePattern,
  resourceCount: number,
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  const result = await clack.confirm({
    message: `Apply this compound plan to provision ${resourceCount} resource${resourceCount === 1 ? "" : "s"} (${pattern.displayName})? [y/N]`,
    initialValue: false,
  });

  if (clack.isCancel(result)) return false;
  return result === true;
}

export function renderApplySuccess(state: RenderableState): void {
  stopSpinner();
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

/**
 * Renders a success summary after all compound provisioning resources complete.
 */
export function renderCompoundSuccess(
  results: ResourceResult[],
  pattern: ArchitecturePattern,
): void {
  stopSpinner();
  const lines = [
    chalk.green.bold(`✓ ${pattern.displayName} provisioned successfully`),
    "",
    ...results.map(
      (r, i) =>
        `  ${i + 1}. ${r.resourceType}${r.resourceArn ? ` → ${r.resourceArn}` : ""}`,
    ),
  ];

  if (process.stdout.isTTY) {
    process.stdout.write(
      boxen(lines.join("\n"), {
        padding: 1,
        borderColor: "green",
        title: "Compound Provisioning Complete",
        titleAlignment: "left",
      }) + "\n",
    );
  } else {
    process.stdout.write(
      `=== Compound Provisioning Complete ===\n${lines.join("\n")}\n======================================\n`,
    );
  }
}

// ── Security warnings (Story 19.2) ────────────────────────────────────────────

/**
 * Renders post-provision security warnings to stdout.
 * Called after successful provisioning when CRITICAL or HIGH findings are detected.
 * Non-blocking — purely informational output.
 *
 * @see Story 19.2, AC #2
 */
export function renderSecurityWarnings(
  resourceArn: string,
  findings: SecurityFinding[],
): void {
  if (findings.length === 0) return;

  console.log(`\n\u26A0 Security findings for ${resourceArn}:`);
  for (const finding of findings) {
    const icon =
      finding.severity === "CRITICAL" ? "\uD83D\uDD34" : "\uD83D\uDFE1";
    console.log(`  ${icon} [${finding.severity}] ${finding.title}`);
    if (finding.recommendation) {
      console.log(`     \u2192 ${finding.recommendation}`);
    }
  }
  console.log(""); // trailing newline
}

// ── Documentation help (Story 7.5) ───────────────────────────────────────────

const DOC_TIMEOUT_MS = 15000;

/**
 * Fetches raw documentation text for a field from the AWS Documentation MCP Server.
 * Returns null with a user-facing message on failure.
 */
async function fetchDocText(
  fieldName: string,
  resourceType: string,
  tools: StructuredTool[],
): Promise<string | null> {
  const searchTool = tools.find(
    (t) => t.name === ToolName.SEARCH_DOCUMENTATION,
  );
  const readTool = tools.find((t) => t.name === ToolName.READ_SECTIONS);

  if (!searchTool || !readTool) {
    clack.log.info(`${fieldName}: No documentation available.`);
    return null;
  }

  const query = `${fieldName} ${resourceType}`;
  const searchResult = await withTimeout(
    searchTool.invoke({ search_phrase: query }),
    DOC_TIMEOUT_MS,
  );

  if (!searchResult) {
    clack.log.info(`${fieldName}: Documentation unavailable (timeout).`);
    return null;
  }

  const topUrl = extractFirstUrl(searchResult);
  if (!topUrl) {
    clack.log.info(`${fieldName}: No documentation page found.`);
    return null;
  }

  let sectionsResult: unknown;
  try {
    sectionsResult = await withTimeout(
      readTool.invoke({ url: topUrl, section_titles: [...DOC_SECTION_TITLES] }),
      DOC_TIMEOUT_MS,
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("No matching sections")) {
      const fullReadTool = tools.find(
        (t) => t.name === ToolName.READ_DOCUMENTATION,
      );
      if (fullReadTool) {
        sectionsResult = await withTimeout(
          fullReadTool.invoke({ url: topUrl }),
          DOC_TIMEOUT_MS,
        );
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  if (!sectionsResult) {
    clack.log.info(`${fieldName}: Documentation page unreachable (timeout).`);
    return null;
  }

  return unwrapMcpText(sectionsResult)
    .replace(/^>\s*\*\*Note\*\*:.*not found.*$/gim, "")
    .trim();
}

/**
 * Fetches and renders a plain-English explanation for a resource field
 * by querying the AWS Documentation MCP Server.
 *
 * Called when the user types `?` at an option-elicitor prompt.
 * Falls back gracefully to a short notice if the server is unreachable or times out.
 */
export async function renderDocHelp(
  fieldName: string,
  resourceType: string,
  tools: StructuredTool[],
  llmClient?: LlmPort,
): Promise<void> {
  try {
    const rawText = await fetchDocText(fieldName, resourceType, tools);
    if (!rawText) return;

    const hint = llmClient
      ? await synthesizeDocHint(fieldName, resourceType, rawText, llmClient)
      : rawText;

    clack.note(hint, `📖 ${fieldName}`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    clack.log.info(`${fieldName}: Documentation unavailable. (${msg})`);
  }
}

/**
 * Calls the LLM to condense raw AWS documentation into a 2-3 sentence
 * plain-English hint focused on the specific field.
 * Returns rawDocText unchanged if synthesis fails or the LLM returns empty.
 * File-private — not exported.
 */
async function synthesizeDocHint(
  fieldName: string,
  resourceType: string,
  rawDocText: string,
  llmClient: LlmPort,
): Promise<string> {
  const prompt = `You are a helpful AWS infrastructure assistant.
A developer typed '?' while configuring the "${fieldName}" field of a "${resourceType}" resource.

Here is the relevant AWS documentation excerpt:
---
${rawDocText}
---

Write a plain-English explanation in exactly 2-3 sentences that directly answers:
"What is ${fieldName}? When should I set it and what values make sense?"

Rules:
- Be concise and practical.
- Do not repeat section headers, code syntax blocks, or CloudFormation YAML/JSON.
- Focus only on the ${fieldName} field, not the overall resource.`;

  const [err, hint] = await llmClient.generateText(prompt);
  if (err || !hint) return rawDocText;
  return hint.trim();
}

// ── Resource list display (Story 18.4) ────────────────────────────────────────

import type { ManagedResource } from "../services/list-resources.js";

/**
 * Renders a table of managed resources.
 * TTY mode: chalk-colored headers with padded columns in a boxen frame.
 * Non-TTY mode: tab-separated values with a header row (no ANSI).
 *
 * @see Story 18.4, AC #2
 */
export function renderResourceTable(resources: ManagedResource[]): void {
  if (process.stdout.isTTY) {
    const header = chalk.bold(
      "Type".padEnd(30) +
        "ARN".padEnd(60) +
        "Region".padEnd(15) +
        "Created".padEnd(20) +
        "Est. Cost",
    );
    const rows = resources.map(
      (r) =>
        r.resourceType.padEnd(30) +
        r.arn.padEnd(60) +
        r.region.padEnd(15) +
        r.createdDate.padEnd(20) +
        r.estimatedMonthlyCost,
    );

    const content = [header, chalk.dim("-".repeat(130)), ...rows].join("\n");

    process.stdout.write(
      boxen(content, {
        title: "Managed Resources",
        titleAlignment: "center",
        borderColor: "cyan",
        padding: 1,
      }) + "\n",
    );
  } else {
    const header = "Type\tARN\tRegion\tCreated\tEst. Cost";
    const rows = resources.map(
      (r) =>
        `${r.resourceType}\t${r.arn}\t${r.region}\t${r.createdDate}\t${r.estimatedMonthlyCost}`,
    );
    process.stdout.write([header, ...rows].join("\n") + "\n");
  }
}

/**
 * Renders the empty-list message with a hint to run `assignee apply`.
 *
 * @see Story 18.4, AC #5
 */
export function renderEmptyList(): void {
  const message =
    "No resources managed by assignee.ai found. Run `assignee apply` to provision your first resource.";
  if (process.stdout.isTTY) {
    process.stdout.write(chalk.yellow(message) + "\n");
  } else {
    process.stdout.write(message + "\n");
  }
}

// ── Status summary display (Story 19.6) ───────────────────────────────────────

import type { StatusData } from "../services/status-aggregator.js";

/**
 * Renders the infrastructure status summary.
 * TTY mode: chalk-colored boxen frame with grouped data.
 * Non-TTY mode: plain text without ANSI codes.
 *
 * @see Story 19.6, AC #1
 */
export function renderStatusSummary(data: StatusData): void {
  const lines: string[] = [
    `Total Resources: ${data.totalResources}`,
    `Total Est. Monthly Cost: ${data.totalEstimatedMonthlyCost}`,
    "",
    "By Type:",
  ];

  for (const t of data.byType) {
    lines.push(
      `  ${t.type.padEnd(30)} ${String(t.count).padEnd(4)} ${t.estimatedMonthlyCost}`,
    );
  }

  lines.push("");
  lines.push("By Region:");

  for (const r of data.byRegion) {
    lines.push(
      `  ${r.region.padEnd(30)} ${String(r.count).padEnd(4)} ${r.estimatedMonthlyCost}`,
    );
  }

  const content = lines.join("\n");

  if (process.stdout.isTTY) {
    process.stdout.write(
      boxen(content, {
        title: "assignee.ai \u2014 Infrastructure Status",
        titleAlignment: "center",
        borderColor: "cyan",
        padding: 1,
      }) + "\n",
    );
  } else {
    process.stdout.write(
      `=== Infrastructure Status ===\n${content}\n=============================\n`,
    );
  }
}

/**
 * Renders the empty-status message with a hint to run `assignee plan`.
 *
 * @see Story 19.6, AC #4
 */
export function renderEmptyStatus(): void {
  const message =
    "No resources managed by assignee.ai. Run `assignee plan` to get started.";
  if (process.stdout.isTTY) {
    process.stdout.write(chalk.yellow(message) + "\n");
  } else {
    process.stdout.write(message + "\n");
  }
}

// ── Option elicitation prompts (Story 7.3) ───────────────────────────────────

/**
 * Renders an interactive prompt for a single resource field.
 * Dispatches to the correct @clack/prompts primitive based on question type.
 * Non-TTY: returns resolved default without prompting (CI-safe).
 * Cancel: returns resolved default as graceful fallback.
 */
export async function renderOptionPrompt(
  field: ResourceField,
  resolved: ResolvedFieldConfig,
): Promise<unknown> {
  const defaultValue = resolved.value ?? field.question.initialValue;

  if (!process.stdin.isTTY) return defaultValue;

  // Display contextual hint before the prompt if present (Story 10.2)
  if (field.question.hint && process.stdout.isTTY) {
    clack.note(field.question.hint, field.name);
  }

  const { question } = field;
  let result: unknown;

  switch (question.type) {
    case "boolean": {
      // Use select instead of confirm so the user can pick '?' to get field help.
      // The '?' sentinel is caught by promptWithHelp, which shows docs and re-prompts.
      const boolDefault =
        typeof defaultValue === "boolean"
          ? defaultValue
            ? "true"
            : "false"
          : "false";
      result = await clack.select({
        message: question.label,
        options: [
          { value: "true", label: "Yes" },
          { value: "false", label: "No" },
          { value: "?", label: "\u2753 ? \u2014 explain this field" },
        ],
        initialValue: boolDefault,
      });
      break;
    }
    case "enum": {
      const enumOptions = [
        { value: "?", label: "\u2753 ? \u2014 explain this field" },
        ...(question.options ?? []).map((o) => ({
          value: o.value,
          label: o.label,
        })),
      ];
      result = await clack.select({
        message: question.label,
        options: enumOptions,
        initialValue:
          typeof defaultValue === "string" ? defaultValue : undefined,
      });
      break;
    }
    case "string": {
      result = await clack.text({
        message: question.label,
        placeholder: question.placeholder ?? "",
        initialValue:
          typeof defaultValue === "string" ? defaultValue : undefined,
        validate: (value) => {
          if (value === "?") return undefined; // Bypass validation for field help
          return question.validate?.(value);
        },
      });
      break;
    }
    case "multi": {
      // clack multiselect crashes with an empty options array.
      // Plugins define Tags with options: [] as a placeholder — real options come
      // from org policy config (Story 7.2). Until 7.2 ships, multi fields with no
      // options are silently skipped (returned as undefined → not stored in elicitedOptions).
      if (!question.options || question.options.length === 0) {
        return undefined;
      }
      result = await clack.multiselect({
        message: question.label,
        options: question.options.map((o) => ({
          value: o.value,
          label: o.label,
        })),
        required: false,
      });
      break;
    }
    default: {
      const _exhaustive: never = question.type;
      throw new AssigneeError(
        `Unknown question type: ${String(_exhaustive)}`,
        "UNKNOWN_QUESTION_TYPE",
      );
    }
  }

  if (clack.isCancel(result)) return defaultValue;

  // Normalise boolean-select results back to actual booleans.
  // The boolean case uses clack.select which returns "true"/"false" strings,
  // but the rest of the app expects actual boolean values.
  if (question.type === "boolean") {
    if (result === "?") return "?";
    return result === "true";
  }

  // Treat empty string inputs (e.g., just pressing Enter on optional fields) as skipped.
  if (typeof result === "string" && result.trim() === "") {
    return undefined;
  }

  return result;
}

/**
 * Prompts user to opt into configuring advanced fields.
 * Non-TTY: returns false (CI-safe).
 */
export async function renderAdvancedConfirm(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const result = await clack.confirm({
    message: "Configure advanced options?",
    initialValue: false,
  });
  if (clack.isCancel(result)) return false;
  return result === true;
}

/**
 * Prompts user to apply the plan immediately after display.
 * Non-TTY: returns false (CI-safe — auto-decline).
 *
 * @see Story 10.3, FR-20
 */
export async function renderApplyNowConfirm(
  state: RenderableState,
): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  const result = await clack.confirm({
    message: `Apply now? (${state.resourceType}, est. ${state.estimatedMonthlyCost ?? "N/A"}/mo) [y/N]`,
    initialValue: false,
  });

  if (clack.isCancel(result)) return false;
  return result === true;
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
