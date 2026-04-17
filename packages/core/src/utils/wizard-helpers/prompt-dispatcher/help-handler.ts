/**
 * HELP-sentinel handler for `promptWithHelp`.
 *
 * Dispatches the `?` keypress to either the LLM trade-off analyzer
 * (for enum/multi/categorySelect fields with options) or the doc-help
 * renderer (for free-form string/boolean fields).
 *
 * @see Story 49.6 (Epic 49) — decompose promptWithHelp god function
 */

import { QuestionTypeName } from "@assignee/core";
import type { LlmPort, ResourceField } from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import { renderDocHelp, renderTradeoffHelp } from "../../display.js";

export interface HelpHandlerParams {
  field: ResourceField;
  resourceType: string;
  tools: StructuredTool[];
  llmClient?: LlmPort;
  userIntent?: string;
}

/**
 * Return a hint string to inject into the next render of the same
 * prompt. Returns the same cache miss semantics as the original
 * inline flow — an empty/undefined string yields a no-op re-render.
 */
export async function handleHelpSentinel(
  params: HelpHandlerParams,
): Promise<string | null> {
  const { field, resourceType, tools, llmClient, userIntent } = params;
  const isEnumOrMulti =
    field.question.type === "enum" || field.question.type === "multi";
  const isCategorySelect =
    field.question.type === QuestionTypeName.CATEGORY_SELECT;

  if (isEnumOrMulti && field.question.options && llmClient) {
    return renderTradeoffHelp(
      field.name,
      resourceType,
      [...field.question.options],
      userIntent ?? "",
      tools,
      llmClient,
    );
  }
  if (isCategorySelect && field.question.categories && llmClient) {
    const allOpts = field.question.categories.flatMap((c) =>
      c.options.map((o) => ({ value: o.value, label: o.label })),
    );
    return renderTradeoffHelp(
      field.name,
      resourceType,
      allOpts,
      userIntent ?? "",
      tools,
      llmClient,
    );
  }
  return renderDocHelp(field.name, resourceType, tools, llmClient);
}
