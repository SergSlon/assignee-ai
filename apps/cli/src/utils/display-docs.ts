/**
 * Documentation help helpers for Assignee.ai CLI.
 * Extracted from display.ts — renderDocHelp, renderTradeoffHelp, fetchDocText, synthesizeDocHint.
 */

import * as clack from "@clack/prompts";
import type { LlmPort } from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../constants/tools.js";
import { DOC_SECTION_TITLES } from "../constants/doc-sections.js";
import { unwrapMcpText } from "./mcp.js";
import { withTimeout } from "./timeout.js";
import { extractFirstUrl } from "./mcp-types.js";

// ── Trade-off analysis help (Story 10.6) ──────────────────────────────────────

const TRADEOFF_TIMEOUT_MS = 10_000;

/**
 * Generates and displays an LLM-powered trade-off analysis for enum/multi options.
 * Called when the user types `?` at an enum or multi prompt.
 * Falls back to `renderDocHelp` on timeout, LLM failure, or missing llmClient.
 *
 * @param fieldName    - The field being configured (e.g. "InstanceType")
 * @param resourceType - The AWS resource type (e.g. RESOURCE_TYPES.EC2_INSTANCE)
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
export async function fetchDocText(
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
export async function synthesizeDocHint(
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
