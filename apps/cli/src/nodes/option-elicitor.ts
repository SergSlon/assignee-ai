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
  MissingRequiredFieldsError,
} from "@assignee/core";
import type {
  ResourceField,
  ResourcePlugin,
  ResolvedFieldConfig,
} from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import type { LlmPort } from "@assignee/core";
import { loadBestPractices, type BestPractice } from "@assignee/best-practices";
import {
  renderOptionPrompt,
  renderAdvancedConfirm,
  renderDocHelp,
} from "../utils/display.js";
import { enrichOptionLabel } from "../utils/option-enrichment.js";
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
 * Enriches enum option labels with contextual metadata (cost/fit/recommended).
 * Pure in-memory transformation — no I/O, no mutations.
 * Only enriches in TTY mode (display-only).
 */
function enrichFieldLabels(fields: ResourceField[]): ResourceField[] {
  if (!process.stdout.isTTY) return fields;
  return fields.map((field) => {
    if (field.question.type !== "enum" || !field.question.options) return field;
    return {
      ...field,
      question: {
        ...field.question,
        options: field.question.options.map((opt) => ({
          ...opt,
          label: enrichOptionLabel(opt),
        })),
      },
    };
  });
}

/**
 * Injects "Recommended by Best Practices" hints into field questions when
 * a BP rule references the field's property path for the given resource type.
 * Pure in-memory transformation — no I/O.
 *
 * @param fields - Resource plugin fields to annotate
 * @param resourceType - The AWS resource type being configured
 * @returns Fields with BP-sourced hints appended to question hints
 *
 * @see Story 12.3, AC #3
 */
export function injectBPHints(
  fields: ResourceField[],
  resourceType: string,
): ResourceField[] {
  let practices: BestPractice[];
  try {
    practices = loadBestPractices();
  } catch {
    return fields;
  }

  const relevantBPs = practices.filter(
    (bp) => bp.resource_type === resourceType,
  );
  if (relevantBPs.length === 0) return fields;

  return fields.map((field) => {
    // Check if any BP references this field's name as a property_path segment
    const matchingBP = relevantBPs.find((bp) => {
      const segments = bp.property_path.split(".");
      return segments.includes(field.name) || bp.property_path === field.name;
    });

    if (!matchingBP) return field;

    const bpHint = `Recommended by Best Practices: ${matchingBP.title}`;
    const existingHint = field.question.hint;
    const combinedHint = existingHint ? `${existingHint}\n${bpHint}` : bpHint;

    return {
      ...field,
      question: {
        ...field.question,
        hint: combinedHint,
      },
    };
  });
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

/**
 * Populates elicitedOptions from plugin defaults when --no-wizard is set.
 * Skips all interactive prompts. Throws MissingRequiredFieldsError if any
 * required field (marked `required: true`) has no initialValue and no plugin default.
 *
 * @param plugin - Resource plugin with field definitions and defaults
 * @returns Populated elicitedOptions record
 * @throws MissingRequiredFieldsError when required fields lack defaults
 */
export function populateDefaultOptions(
  plugin: ResourcePlugin,
): Record<string, unknown> {
  const elicitedOptions: Record<string, unknown> = {};
  const missingFields: string[] = [];

  const allFields = [...plugin.commonFields, ...plugin.advancedFields];

  for (const field of allFields) {
    // Skip conditionally shown fields — they depend on interactive choices
    if (field.question.showIf) continue;

    const initialValue = field.question.initialValue;
    const pluginDefault = plugin.defaults[field.name];

    if (initialValue !== undefined) {
      elicitedOptions[field.name] = initialValue;
    } else if (pluginDefault !== undefined) {
      elicitedOptions[field.name] = pluginDefault;
    } else if (field.required) {
      missingFields.push(field.name);
    }
  }

  if (missingFields.length > 0) {
    throw new MissingRequiredFieldsError(missingFields);
  }

  return elicitedOptions;
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

  // Story 11.1: --no-wizard bypasses all interactive prompts, uses plugin defaults
  if (state.noWizard) {
    const plugin =
      defaultPluginRegistry.get(state.resourceType) ??
      defaultPluginRegistry.get("generic")!;
    const elicitedOptions = populateDefaultOptions(plugin);
    return { elicitedOptions };
  }

  // Non-TTY (CI/pipes): skip all prompts
  if (!process.stdin.isTTY) return { elicitedOptions: {} };

  const plugin =
    defaultPluginRegistry.get(state.resourceType) ??
    defaultPluginRegistry.get("generic")!;

  // Enrich enum option labels with live prices when tools are available
  const pricedFields =
    tools && tools.length > 0
      ? await enrichWithLivePricing(plugin, tools)
      : plugin.commonFields;

  // Story 12.3: Inject BP-sourced hints into field prompts
  const bpHintedCommon = injectBPHints(pricedFields, state.resourceType);
  const bpHintedAdvanced = injectBPHints(
    plugin.advancedFields,
    state.resourceType,
  );

  // Enrich with contextual metadata (cost/fit/recommended) from plugin definitions
  const commonFields = enrichFieldLabels(bpHintedCommon);

  // Enrich advanced fields with contextual metadata too
  const advancedFields = enrichFieldLabels(bpHintedAdvanced);

  const resolvedCommon = resolveFieldConfigs(commonFields);
  const resolvedAdvanced = resolveFieldConfigs(advancedFields);

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
  if (advancedFields.length > 0) {
    const showAdvanced = await renderAdvancedConfirm();
    if (showAdvanced) {
      for (const field of advancedFields) {
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
