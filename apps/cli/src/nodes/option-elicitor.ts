/**
 * option_elicitor node — interactively collects resource configuration from the user
 * before plan generation, using the ResourcePlugin field definitions from Story 7.1.
 *
 * Live pricing: fetches real-time on-demand prices from the AWS Pricing API MCP server
 * before the prompt loop and injects them into enum option labels.
 *
 * Policy resolution: Story 7.2 (mergeConfigs) is not yet implemented.
 * Until then, all fields use plugin initialValue with ask_if_not_set policy.
 * When Story 7.2 lands, replace `resolveFieldConfigs()` with `mergeConfigs()`.
 *
 * @see Story 7.3
 */

import * as clack from "@clack/prompts";
import {
  ExecutionStatus,
  RESOURCE_TYPES,
  defaultPluginRegistry,
} from "@assignee/core";
import type {
  ResourceField,
  ResourcePlugin,
  ResolvedFieldConfig,
} from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import type { LlmPort } from "@assignee/core";
import {
  renderOptionPrompt,
  renderAdvancedConfirm,
  renderDocHelp,
} from "../utils/display.js";
import {
  fetchEc2InstancePrices,
  fetchRdsInstancePrices,
} from "../utils/pricing-lookup.js";
import { FieldPolicy, FieldSource } from "../constants/field-policy.js";
import { ResourceFieldName } from "../constants/resource-fields.js";
import type { AgentState } from "../services/graph.js";

/**
 * Minimal config resolver used until Story 7.2 (mergeConfigs) is implemented.
 * Maps each plugin field to a ResolvedFieldConfig using plugin initialValue as default.
 * All fields are ask_if_not_set — no org locking or user config applied yet.
 */
function resolveFieldConfigs(
  fields: ResourceField[],
): Record<string, ResolvedFieldConfig> {
  const result: Record<string, ResolvedFieldConfig> = {};
  for (const field of fields) {
    const pluginDefault = field.question.initialValue;
    result[field.name] =
      pluginDefault !== undefined
        ? {
            policy: FieldPolicy.ASK_IF_NOT_SET,
            value: pluginDefault,
            source: FieldSource.PLUGIN_DEFAULT,
          }
        : {
            policy: FieldPolicy.ALWAYS_ASK,
            source: FieldSource.PLUGIN_DEFAULT,
          };
  }
  return result;
}

/** Fetches live prices for a specific resource type and returns the field name + price map. */
async function fetchPricesForResource(
  plugin: ResourcePlugin,
  tools: StructuredTool[],
): Promise<{ fieldName: string; priceMap: Record<string, string> } | null> {
  const resourceType = plugin.resourceType;

  if (resourceType === RESOURCE_TYPES.EC2_INSTANCE) {
    const field = plugin.commonFields.find(
      (f) =>
        f.name === ResourceFieldName.INSTANCE_TYPE &&
        f.question.type === "enum",
    );
    if (field?.question.type === "enum" && field.question.options) {
      const s = clack.spinner();
      s.start("Fetching live EC2 instance prices…");
      const priceMap = await fetchEc2InstancePrices(
        tools,
        field.question.options.map((o) => o.value),
      );
      s.stop(
        Object.keys(priceMap).length > 0
          ? "Live prices loaded"
          : "Using estimated prices",
      );
      return { fieldName: ResourceFieldName.INSTANCE_TYPE, priceMap };
    }
  }

  if (resourceType === RESOURCE_TYPES.RDS_DB_INSTANCE) {
    const instanceClassField = plugin.commonFields.find(
      (f) =>
        f.name === ResourceFieldName.DB_INSTANCE_CLASS &&
        f.question.type === "enum",
    );
    const engineField = plugin.commonFields.find(
      (f) => f.name === ResourceFieldName.ENGINE,
    );
    const engine =
      engineField?.question.type === "enum"
        ? ((engineField.question.initialValue as string | undefined) ??
          "postgres")
        : "postgres";
    if (
      instanceClassField?.question.type === "enum" &&
      instanceClassField.question.options
    ) {
      const s = clack.spinner();
      s.start("Fetching live RDS instance prices…");
      const priceMap = await fetchRdsInstancePrices(
        tools,
        instanceClassField.question.options.map((o) => o.value),
        engine,
      );
      s.stop(
        Object.keys(priceMap).length > 0
          ? "Live prices loaded"
          : "Using estimated prices",
      );
      return { fieldName: ResourceFieldName.DB_INSTANCE_CLASS, priceMap };
    }
  }

  return null;
}

/** Injects live price labels into enum option fields. */
function injectPriceLabels(
  fields: ResourceField[],
  fieldName: string,
  priceMap: Record<string, string>,
): ResourceField[] {
  return fields.map((field) => {
    if (field.name !== fieldName || field.question.type !== "enum")
      return field;
    return {
      ...field,
      question: {
        ...field.question,
        options: field.question.options?.map((opt) => {
          const livePrice = priceMap[opt.value];
          if (!livePrice) return opt;
          const label = opt.label.includes(" — ")
            ? `${opt.label.split(" — ")[0]} — ${livePrice}`
            : `${opt.label} — ${livePrice}`;
          return { ...opt, label };
        }),
      },
    };
  });
}

/**
 * Returns a copy of the field list with live prices injected into enum option labels.
 * Only enriches InstanceType (EC2) and DBInstanceClass (RDS) fields.
 * Falls back silently to original fields if pricing fetch fails or tools unavailable.
 */
async function enrichWithLivePricing(
  plugin: ResourcePlugin,
  tools: StructuredTool[],
): Promise<ResourceField[]> {
  const result = await fetchPricesForResource(plugin, tools);
  if (!result || Object.keys(result.priceMap).length === 0) {
    return plugin.commonFields;
  }
  return injectPriceLabels(
    plugin.commonFields,
    result.fieldName,
    result.priceMap,
  );
}

/**
 * Wraps renderOptionPrompt with a `?` help loop.
 * If the user types `?` at a string-type prompt, fetches and displays AWS
 * documentation for the field, then re-presents the same prompt.
 * File-private — not exported.
 *
 * @param field        - The resource field being prompted
 * @param resolved     - Resolved policy/value config for the field
 * @param resourceType - The AWS resource type (e.g. "AWS::S3::Bucket")
 * @param tools        - LangChain tools array (passed through from node)
 * @param llmClient    - Optional LLM client forwarded to renderDocHelp for synthesis
 */
async function promptWithHelp(
  field: ResourceField,
  resolved: ResolvedFieldConfig,
  resourceType: string,
  tools: StructuredTool[],
  llmClient?: LlmPort,
): Promise<unknown> {
  while (true) {
    const answer = await renderOptionPrompt(field, resolved);
    if (answer === "?") {
      await renderDocHelp(field.name, resourceType, tools, llmClient);
      continue;
    }
    return answer;
  }
}

export async function optionElicitorNode(
  state: AgentState,
  tools?: StructuredTool[],
  llmClient?: LlmPort,
): Promise<Partial<AgentState>> {
  if (state.resourcePattern) {
    // Compound intent: elicitation skipped — pattern defaultOptions provide configuration
    return {};
  }

  if (state.executionStatus !== ExecutionStatus.PENDING) return {};

  // Non-TTY (CI/pipes): skip all prompts
  if (!process.stdin.isTTY) return { elicitedOptions: {} };

  const plugin =
    defaultPluginRegistry.get(state.resourceType) ??
    defaultPluginRegistry.get("generic")!;

  // Enrich enum option labels with live prices when tools are available
  const commonFields =
    tools && tools.length > 0
      ? await enrichWithLivePricing(plugin, tools)
      : plugin.commonFields;

  const resolvedCommon = resolveFieldConfigs(commonFields);
  const resolvedAdvanced = resolveFieldConfigs(plugin.advancedFields);

  const elicitedOptions: Record<string, unknown> = {};

  // ── Common tier ──────────────────────────────────────────────────────────────
  for (const field of commonFields) {
    const resolved = resolvedCommon[field.name];
    if (!resolved) continue;

    // showIf conditional — skip if condition not met
    if (field.question.showIf) {
      const depValue = elicitedOptions[field.question.showIf.field];
      if (depValue !== field.question.showIf.value) continue;
    }

    if (resolved.policy === FieldPolicy.NEVER_ASK) {
      if (resolved.value !== undefined)
        elicitedOptions[field.name] = resolved.value;
      continue;
    }

    if (resolved.policy === FieldPolicy.ASK_IF_NOT_SET) {
      if (elicitedOptions[field.name] !== undefined) continue;
    }

    const answer = await promptWithHelp(
      field,
      resolved,
      state.resourceType,
      tools ?? [],
      llmClient,
    );
    if (answer !== undefined && answer !== "") {
      elicitedOptions[field.name] = answer;
    }
  }

  // ── Advanced tier gate ───────────────────────────────────────────────────────
  if (plugin.advancedFields.length > 0) {
    const showAdvanced = await renderAdvancedConfirm();
    if (showAdvanced) {
      for (const field of plugin.advancedFields) {
        const resolved = resolvedAdvanced[field.name];
        if (!resolved) continue;

        if (field.question.showIf) {
          const depValue = elicitedOptions[field.question.showIf.field];
          if (depValue !== field.question.showIf.value) continue;
        }

        if (resolved.policy === FieldPolicy.NEVER_ASK) {
          if (resolved.value !== undefined)
            elicitedOptions[field.name] = resolved.value;
          continue;
        }

        const answer = await promptWithHelp(
          field,
          resolved,
          state.resourceType,
          tools ?? [],
          llmClient,
        );
        if (answer !== undefined && answer !== "") {
          elicitedOptions[field.name] = answer;
        }
      }
    }
  }

  return { elicitedOptions };
}
