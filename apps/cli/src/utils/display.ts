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
  verbose?: boolean;
}

// ── Friendly key names for plan box rendering (Story 18.11) ─────────────────

const FRIENDLY_NAMES: Record<string, string> = {
  InstanceType: "Instance Type",
  ImageId: "AMI",
  KeyName: "Key Pair",
  SubnetId: "Subnet",
  SecurityGroupIds: "Security Groups",
  BucketName: "Bucket Name",
  BucketEncryption: "Encryption",
  PublicAccessBlockConfiguration: "Block Public Access",
  VersioningConfiguration: "Versioning",
  DBInstanceClass: "DB Instance Class",
  Engine: "Engine",
  MasterUsername: "Master Username",
  MasterUserPassword: "Master Password",
  AllocatedStorage: "Storage (GB)",
  MultiAZ: "Multi-AZ",
  StorageType: "Storage Type",
  FunctionName: "Function Name",
  Runtime: "Runtime",
  Handler: "Handler",
  MemorySize: "Memory (MB)",
  Timeout: "Timeout (s)",
  Role: "Execution Role",
  Tags: "Tags",
  DBName: "Database Name",
  EngineVersion: "Engine Version",
  DeletionProtection: "Deletion Protection",
  BackupRetentionPeriod: "Backup Retention (days)",
  Description: "Description",
  ReservedConcurrentExecutions: "Reserved Concurrency",
  Environment: "Environment Variables",
  IamInstanceProfile: "IAM Instance Profile",
  UserData: "User Data",
  KMSMasterKeyID: "KMS Key ID",
  EnableLifecycle: "Lifecycle Rules",
  EnableCors: "CORS",
  EnableReplication: "Cross-Region Replication",
};

/**
 * Converts a PascalCase key to a spaced name (fallback for unknown keys).
 * E.g., "IamInstanceProfile" -> "Iam Instance Profile"
 */
function spacePascalCase(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/**
 * Formats a desiredState record as a human-readable key-value table.
 * Arrays are joined with commas. Objects render as nested key-value pairs.
 * Booleans render as "Yes"/"No". Strings and numbers render as-is.
 */
export function formatDesiredState(state: Record<string, unknown>): string {
  const entries = Object.entries(state);
  if (entries.length === 0) return "(none)";

  const lines: string[] = [];
  const maxKeyLen = Math.max(
    ...entries.map(([k]) => (FRIENDLY_NAMES[k] ?? spacePascalCase(k)).length),
  );

  for (const [key, value] of entries) {
    const friendlyKey = FRIENDLY_NAMES[key] ?? spacePascalCase(key);
    const padded = friendlyKey.padEnd(maxKeyLen);
    const formatted = formatValue(value);
    lines.push(`  ${padded}   ${formatted}`);
  }

  return lines.join("\n");
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) {
    // Arrays of objects (e.g., Tags [{Key, Value}]) — show as Key:Value pairs
    if (
      value.length > 0 &&
      typeof value[0] === "object" &&
      value[0] !== null &&
      "Key" in value[0]
    ) {
      return value
        .map(
          (item: Record<string, unknown>) => `${item["Key"]}:${item["Value"]}`,
        )
        .join(", ");
    }
    return value.map(String).join(", ");
  }
  if (typeof value === "object") {
    // Nested objects — show key: value pairs inline
    const obj = value as Record<string, unknown>;
    return Object.entries(obj)
      .map(([k, v]) => `${k}: ${formatValue(v)}`)
      .join(", ");
  }
  return String(value);
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

  const configBlock = state.desiredState
    ? formatDesiredState(state.desiredState)
    : "(none)";

  const content = [
    `Resource Type:   ${state.resourceType}`,
    `Region:          ${regionLabel()}`,
    `Config:`,
    configBlock,
    `Estimated Cost:  ${state.estimatedMonthlyCost ?? "N/A"}`,
    ...(freeTierLine ? [freeTierLine] : []),
    ...(memoryHintLines ? [memoryHintLines] : []),
    findingsLine,
    ...(state.verbose || process.argv.includes("--verbose")
      ? [`Run ID:          ${state.runId}`]
      : []),
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

  if (clack.isCancel(result)) {
    clack.cancel("Cancelled.");
    process.exit(130);
  }
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

  if (clack.isCancel(result)) {
    clack.cancel("Cancelled.");
    process.exit(130);
  }
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

// ── Trade-off analysis help (Story 10.6) ──────────────────────────────────────

const TRADEOFF_TIMEOUT_MS = 10_000;

/**
 * Generates and displays an LLM-powered trade-off analysis for enum/multi options.
 * Called when the user types `?` at an enum or multi prompt.
 * Falls back to `renderDocHelp` on timeout, LLM failure, or missing llmClient.
 *
 * @param fieldName    - The field being configured (e.g. "InstanceType")
 * @param resourceType - The AWS resource type (e.g. "AWS::EC2::Instance")
 * @param options      - Available enum/multi options with value and label
 * @param userIntent   - The user's original natural-language intent
 * @param tools        - LangChain tools array (passed through for fallback)
 * @param llmClient    - Optional LLM client for generating the trade-off analysis
 *
 * @see Story 10.6
 */
export async function renderTradeoffHelp(
  fieldName: string,
  resourceType: string,
  options: Array<{ value: string; label: string }>,
  userIntent: string,
  tools: StructuredTool[],
  llmClient?: LlmPort,
): Promise<string | null> {
  if (!llmClient) {
    return renderDocHelp(fieldName, resourceType, tools);
  }

  const optionList = options.map((o) => `- ${o.value}: ${o.label}`).join("\n");

  const prompt = `You are an AWS infrastructure cost/performance advisor.
A developer is configuring a "${resourceType}" resource and needs to choose a value for "${fieldName}".

Their stated intent: "${userIntent}"

Available options:
${optionList}

Compare the top 3-5 most relevant options for this developer's use case. For each option provide:
1. Option name
2. Estimated monthly cost at typical usage (e.g., "~$8/mo for light workloads")
3. Best use case (1 sentence)

End with a one-sentence recommendation based on their intent.

Rules:
- Be concise — no more than 15 lines total.
- Use plain text, no markdown headers or code blocks.
- If you don't know exact pricing, give reasonable estimates with "~".`;

  try {
    const result = await withTimeout(
      llmClient.generateText(prompt),
      TRADEOFF_TIMEOUT_MS,
    );

    if (!result) {
      // Timeout — fall back to doc help
      return renderDocHelp(fieldName, resourceType, tools, llmClient);
    }

    const [err, text] = result;
    if (err || !text) {
      return renderDocHelp(fieldName, resourceType, tools, llmClient);
    }

    const trimmed = text.trim();
    clack.note(trimmed, `⚖️ ${fieldName} — Trade-off Analysis`);
    return trimmed;
  } catch {
    // LLM call threw — fall back to doc help
    return renderDocHelp(fieldName, resourceType, tools, llmClient);
  }
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
): Promise<string | null> {
  try {
    const rawText = await fetchDocText(fieldName, resourceType, tools);
    if (!rawText) return null;

    const hint = llmClient
      ? await synthesizeDocHint(fieldName, resourceType, rawText, llmClient)
      : rawText;

    clack.note(hint, `📖 ${fieldName}`);
    return hint;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    clack.log.info(`${fieldName}: Documentation unavailable. (${msg})`);
    return null;
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
        ...(question.options ?? []).map((o) => ({
          value: o.value,
          label: o.label,
        })),
        { value: "__other__", label: "Other \u2014 enter manually" },
        { value: "?", label: "\u2753 ? \u2014 explain this field" },
      ];
      result = await clack.select({
        message: question.label,
        options: enumOptions,
        initialValue:
          typeof defaultValue === "string" ? defaultValue : undefined,
      });
      if (result === "__other__") {
        const customValue = await clack.text({
          message: `${question.label} \u2014 Enter value`,
          placeholder: question.placeholder ?? "",
        });
        if (clack.isCancel(customValue)) {
          clack.cancel("Wizard cancelled.");
          process.exit(130);
        }
        return typeof customValue === "string"
          ? customValue.trim()
          : defaultValue;
      }
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
        options: [
          { value: "?", label: "\u2753 ? \u2014 explain these options" },
          ...question.options.map((o) => ({
            value: o.value,
            label: o.label,
          })),
          { value: "__other__", label: "Other \u2014 enter manually" },
        ],
        required: false,
      });
      // If user selected "__other__", prompt for comma-separated custom values
      if (Array.isArray(result) && result.includes("__other__")) {
        const otherValues = result.filter((v: string) => v !== "__other__");
        const customInput = await clack.text({
          message: `${question.label} \u2014 Enter additional values (comma-separated)`,
          placeholder: "value1, value2",
        });
        if (clack.isCancel(customInput)) {
          clack.cancel("Wizard cancelled.");
          process.exit(130);
        }
        if (typeof customInput === "string" && customInput.trim()) {
          const customValues = customInput
            .split(",")
            .map((v: string) => v.trim())
            .filter(Boolean);
          return [...otherValues, ...customValues];
        }
        return otherValues;
      }
      break;
    }
    case "categorySelect": {
      // Story 18.12: Two-step category → size selection for grouped options.
      const categories = question.categories;
      if (!categories || categories.length === 0) {
        // Fallback: treat as flat enum if no categories defined
        return defaultValue;
      }

      // Determine if we can skip the category step via intent-based categoryHint
      // or by finding which category the default value belongs to.
      let selectedCategoryKey: string | undefined = resolved.categoryHint;
      let skipCategory = !!selectedCategoryKey;

      // If no explicit categoryHint but we have a default value, find its category
      if (!selectedCategoryKey && typeof defaultValue === "string") {
        for (const cat of categories) {
          if (cat.options.some((o) => o.value === defaultValue)) {
            // Don't auto-skip when only initialValue is set (no intent match)
            // Only pre-select if there's a categoryHint
            break;
          }
        }
      }

      // Step 1: Category selection (unless skipped by intent)
      if (!skipCategory) {
        let categoryResult: string | symbol;

        // Category select loop (supports ? help)
        while (true) {
          categoryResult = (await clack.select({
            message: `${question.label} — Choose a category`,
            options: [
              ...categories.map((cat) => ({
                value: cat.key,
                label: cat.label,
                hint: cat.description,
              })),
              {
                value: "__other__",
                label: "Other \u2014 enter any instance type manually",
              },
              { value: "?", label: "\u2753 ? \u2014 explain this field" },
            ],
            initialValue: categories[0]?.key,
          })) as string | symbol;

          if (clack.isCancel(categoryResult)) {
            clack.cancel("Wizard cancelled.");
            process.exit(130);
          }

          if (categoryResult === "?") {
            const helpLines = categories
              .map((cat) => `${cat.label}\n  ${cat.description}`)
              .join("\n\n");
            clack.note(helpLines, "Instance Type Categories");
            continue;
          }

          // "Other" — free-text input for any instance type (GPU, storage, etc.)
          if (categoryResult === "__other__") {
            const customType = await clack.text({
              message: `${question.label} — Enter instance type`,
              placeholder: "p3.2xlarge",
              validate: (value) => {
                if (!value || !value.trim()) return "Instance type is required";
                if (!/^[a-z][a-z0-9]*\.[a-z0-9]+$/.test(value.trim()))
                  return "Format: family.size (e.g., p3.2xlarge, g5.xlarge, i3.large)";
                return undefined;
              },
            });
            if (clack.isCancel(customType)) {
              clack.cancel("Wizard cancelled.");
              process.exit(130);
            }
            return typeof customType === "string"
              ? customType.trim()
              : defaultValue;
          }

          selectedCategoryKey = categoryResult as string;
          break;
        }
      } else {
        // Show info that category was auto-selected
        const matchedCat = categories.find(
          (c) => c.key === selectedCategoryKey,
        );
        if (matchedCat) {
          clack.log.info(
            `Category auto-selected: ${matchedCat.label} — based on your intent`,
          );
        }
      }

      // Step 2: Size selection within the selected category
      const selectedCategory = categories.find(
        (c) => c.key === selectedCategoryKey,
      );
      if (!selectedCategory) {
        return defaultValue;
      }

      const sizeOptions = [
        ...selectedCategory.options.map((o) => ({
          value: o.value,
          label: o.label,
        })),
        {
          value: "__other__",
          label: "Other \u2014 enter size manually",
        },
        { value: "?", label: "\u2753 ? \u2014 explain this field" },
      ];

      // Pre-select the default if it exists in this category, otherwise first option
      const sizeInitial =
        typeof defaultValue === "string" &&
        selectedCategory.options.some((o) => o.value === defaultValue)
          ? defaultValue
          : selectedCategory.options[0]?.value;

      result = await clack.select({
        message: `${question.label} — ${selectedCategory.label.split(" — ")[0]}`,
        options: sizeOptions,
        initialValue: sizeInitial,
      });
      if (result === "__other__") {
        const customSize = await clack.text({
          message: `${question.label} — Enter size for ${selectedCategoryKey} family`,
          placeholder: `${selectedCategoryKey}.2xlarge`,
        });
        if (clack.isCancel(customSize)) {
          clack.cancel("Wizard cancelled.");
          process.exit(130);
        }
        return typeof customSize === "string"
          ? customSize.trim()
          : defaultValue;
      }
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

  if (clack.isCancel(result)) {
    clack.cancel("Wizard cancelled.");
    process.exit(130);
  }

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
  if (clack.isCancel(result)) {
    clack.cancel("Cancelled.");
    process.exit(130);
  }
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

  if (clack.isCancel(result)) {
    clack.cancel("Cancelled.");
    process.exit(130);
  }
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
