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
} from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import type { LlmPort } from "@assignee/core";
import { ToolName } from "../constants/tools.js";
import { unwrapMcpText } from "./mcp.js";

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
  stopSpinner();
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

export function renderError(message: string, hint?: string): void {
  stopSpinner();
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

// ── Documentation help (Story 7.5) ───────────────────────────────────────────

const DOC_TIMEOUT_MS = 15000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * Extracts the first documentation URL from the search_documentation response.
 *
 * The aws-documentation-mcp-server returns a structured object with:
 *   response.structuredContent.search_results[0].url
 *
 * Falls back to scanning the stringified response for an https:// URL if
 * the structured shape is not present (future-proofs against schema changes).
 */
function extractFirstUrl(response: unknown): string | null {
  // Preferred: structured content path
  if (
    response !== null &&
    typeof response === "object" &&
    "structuredContent" in response
  ) {
    const sc = (response as Record<string, unknown>)["structuredContent"];
    if (
      sc !== null &&
      typeof sc === "object" &&
      "search_results" in sc &&
      Array.isArray((sc as Record<string, unknown>)["search_results"])
    ) {
      const results = (sc as Record<string, unknown[]>)["search_results"];
      const first = results?.at(0);
      if (
        first !== undefined &&
        typeof first === "object" &&
        first !== null &&
        "url" in first &&
        typeof (first as Record<string, unknown>)["url"] === "string"
      ) {
        return (first as Record<string, string>)["url"] ?? null;
      }
    }
  }

  // Fallback: scan stringified response for a URL (dots are valid URL chars)
  const match = JSON.stringify(response).match(/https?:\/\/[^\s\)\"\\,;!]+/);
  return match?.[0] ?? null;
}

/**
 * Fetches and renders a plain-English explanation for a resource field
 * by querying the AWS Documentation MCP Server.
 *
 * Called when the user types `?` at an option-elicitor prompt.
 * Falls back gracefully to a short notice if the server is unreachable or times out.
 *
 * @param fieldName    - The resource field name (e.g. "BucketName")
 * @param resourceType - The AWS resource type (e.g. "AWS::S3::Bucket")
 * @param tools        - LangChain tools array from the graph (injected, not imported)
 * @param llmClient    - Optional LLM client; when provided synthesizes a short hint instead of raw docs
 */
export async function renderDocHelp(
  fieldName: string,
  resourceType: string,
  tools: StructuredTool[],
  llmClient?: LlmPort,
): Promise<void> {
  const searchTool = tools.find(
    (t) => t.name === ToolName.SEARCH_DOCUMENTATION,
  );
  const readTool = tools.find((t) => t.name === ToolName.READ_SECTIONS);

  if (!searchTool || !readTool) {
    clack.log.info(`${fieldName}: No documentation available.`);
    return;
  }

  try {
    const query = `${fieldName} ${resourceType}`;
    const searchResult = await withTimeout(
      searchTool.invoke({ search_phrase: query }),
      DOC_TIMEOUT_MS,
    );

    if (!searchResult) {
      clack.log.info(`${fieldName}: Documentation unavailable (timeout).`);
      return;
    }

    // search_documentation returns a structured response object.
    // Try to extract the first URL from structuredContent.search_results,
    // falling back to scanning the stringified response if needed.
    const topUrl = extractFirstUrl(searchResult);
    if (!topUrl) {
      clack.log.info(`${fieldName}: No documentation page found.`);
      return;
    }

    let sectionsResult: unknown;
    try {
      sectionsResult = await withTimeout(
        readTool.invoke({
          url: topUrl,
          section_titles: ["Overview", "Description", "Properties", "Syntax"],
        }),
        DOC_TIMEOUT_MS,
      );
    } catch (err: any) {
      if (err.message && err.message.includes("No matching sections")) {
        const fullReadTool = tools.find((t) => t.name === "read_documentation");
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
      return;
    }

    // Strip the MCP server's 'sections not found' trailing note — noise for end users.
    const rawText = unwrapMcpText(sectionsResult)
      .replace(/^>\s*\*\*Note\*\*:.*not found.*$/gim, "")
      .trim();

    // When an LLM client is available, synthesize a concise field-focused hint.
    // Falls back to raw doc text if synthesis fails or returns empty.
    const hint = llmClient
      ? await synthesizeDocHint(fieldName, resourceType, rawText, llmClient)
      : rawText;

    clack.note(hint, `📖 ${fieldName}`);
  } catch (error: any) {
    clack.log.info(
      `${fieldName}: Documentation unavailable. (${error.message})`,
    );
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
