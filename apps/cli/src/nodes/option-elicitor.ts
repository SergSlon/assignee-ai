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
import { defaultMemoryService } from "../services/memory.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
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
  renderTradeoffHelp,
  stopSpinner,
} from "../utils/display.js";
import { enrichOptionLabel } from "../utils/option-enrichment.js";
import {
  fetchEc2InstancePrices,
  fetchRdsInstancePrices,
} from "../utils/pricing-lookup.js";
import {
  discoverAmis,
  discoverSubnets,
  discoverSecurityGroups,
  discoverKeyPairs,
} from "../utils/aws-resource-discovery.js";
import { FieldPolicy, FieldSource } from "../constants/field-policy.js";
import { ResourceFieldName } from "../constants/resource-fields.js";
import {
  evaluateWizardRecommendations,
  displayRecommendations,
} from "../utils/wizard-recommendations.js";
import {
  getIntentDefaults,
  applyIntentOverrides,
} from "../utils/intent-defaults.js";
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

/**
 * Fetches live prices for a specific resource type and returns the field name + price map.
 * Spinner-free — callers are responsible for spinner lifecycle.
 */
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
      const priceMap = await fetchEc2InstancePrices(
        tools,
        field.question.options.map((o) => o.value),
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
      const priceMap = await fetchRdsInstancePrices(
        tools,
        instanceClassField.question.options.map((o) => o.value),
        engine,
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

/** Maps fetcher identifiers to discovery functions. */
const fetcherMap: Record<
  string,
  () => Promise<Array<{ value: string; label: string }>>
> = {
  "discover-amis": discoverAmis,
  "discover-subnets": discoverSubnets,
  "discover-security-groups": discoverSecurityGroups,
  "discover-key-pairs": discoverKeyPairs,
};

/**
 * Resolves dynamic fields by fetching live options from AWS.
 * Fields with a `fetcher` identifier get their options populated at runtime.
 * If a fetch returns empty results, the field reverts to string type for manual entry.
 * Spinner-free — callers are responsible for spinner lifecycle.
 * @see Story 7.11
 */
async function resolveDynamicFields(
  fields: ResourceField[],
): Promise<ResourceField[]> {
  const dynamicFields = fields.filter((f) => f.question.fetcher);
  if (dynamicFields.length === 0) return fields;

  const fetchResults = new Map<
    string,
    Array<{ value: string; label: string }>
  >();
  await Promise.all(
    dynamicFields.map(async (field) => {
      const fetch = fetcherMap[field.question.fetcher!];
      if (!fetch) return;
      try {
        const options = await fetch();
        fetchResults.set(field.name, options);
      } catch {
        fetchResults.set(field.name, []);
      }
    }),
  );

  return fields.map((field) => {
    if (!field.question.fetcher) return field;
    const options = fetchResults.get(field.name) ?? [];

    if (options.length === 0) {
      // Fallback to manual string entry
      return {
        ...field,
        question: {
          ...field.question,
          type: "string" as const,
          options: undefined,
          fetcher: undefined,
        },
      };
    }

    return {
      ...field,
      question: {
        ...field.question,
        options,
      },
    };
  });
}

/**
 * Merges two independently-enriched field arrays (pricing + discovery).
 * For each field: if discovery provided options (fetcher field with resolved options),
 * use the discovery result. Otherwise, use the pricing-enriched version.
 * Pricing enriches InstanceType/DBInstanceClass labels; discovery populates
 * ImageId/SubnetId/SecurityGroupIds/KeyName options. They target different fields,
 * so the merge is a field-level union.
 *
 * @see Story 9.10
 */
function mergeEnrichedFields(
  pricedFields: ResourceField[],
  discoveryFields: ResourceField[],
): ResourceField[] {
  // Discovery processes all fetcher fields — successful ones get options,
  // failed ones get converted to type:"string" (manual entry fallback).
  // Index by name so we can look up the discovery result for each field.
  const discoveryMap = new Map(discoveryFields.map((f) => [f.name, f]));

  return pricedFields.map((field) => {
    // For fields with a fetcher, ALWAYS use the discovery version —
    // it either has resolved options or fell back to string type.
    // For non-fetcher fields (e.g., InstanceType), use the priced version
    // which has live pricing labels enriched.
    if (field.question.fetcher) {
      return discoveryMap.get(field.name) ?? field;
    }
    return field;
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
 * If the user types `?` at a string/boolean prompt, fetches and displays AWS
 * documentation for the field, then re-presents the same prompt.
 * If the user types `?` at an enum/multi prompt, renders an LLM-powered
 * trade-off analysis instead (Story 10.6).
 * File-private — not exported.
 *
 * @param field        - The resource field being prompted
 * @param resolved     - Resolved policy/value config for the field
 * @param resourceType - The AWS resource type (e.g. "AWS::S3::Bucket")
 * @param tools        - LangChain tools array (passed through from node)
 * @param llmClient    - Optional LLM client forwarded to renderDocHelp/renderTradeoffHelp
 * @param userIntent   - Optional user intent string for context-aware trade-off analysis
 */
async function promptWithHelp(
  field: ResourceField,
  resolved: ResolvedFieldConfig,
  resourceType: string,
  tools: StructuredTool[],
  llmClient?: LlmPort,
  userIntent?: string,
): Promise<unknown> {
  let cachedHint: string | null = null;

  while (true) {
    // If we have a cached hint from a previous ? press, inject it into the field
    const promptField = cachedHint
      ? {
          ...field,
          question: { ...field.question, hint: cachedHint },
        }
      : field;

    const answer = await renderOptionPrompt(promptField, resolved);

    // Multi fields: when user selects only '?', trigger help
    const isHelpRequest =
      answer === "?" ||
      (Array.isArray(answer) && answer.length === 1 && answer[0] === "?");

    if (isHelpRequest) {
      const isEnumOrMulti =
        field.question.type === "enum" || field.question.type === "multi";

      if (isEnumOrMulti && field.question.options && llmClient) {
        cachedHint = await renderTradeoffHelp(
          field.name,
          resourceType,
          [...field.question.options],
          userIntent ?? "",
          tools,
          llmClient,
        );
      } else {
        cachedHint = await renderDocHelp(
          field.name,
          resourceType,
          tools,
          llmClient,
        );
      }
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

  // Stop the outer "Generating plan..." spinner before interactive prompts
  stopSpinner();

  const plugin =
    defaultPluginRegistry.get(state.resourceType) ??
    defaultPluginRegistry.get("generic")!;

  // Story 9.10: Parallel fan-out — pricing enrichment and dynamic field discovery
  // run concurrently. They operate on different fields (pricing → InstanceType labels,
  // discovery → AMI/Subnet/SG/KeyPair options) so results merge without conflict.
  const parallelSpinner = clack.spinner();
  parallelSpinner.start("Preparing your wizard…");

  const startMs = Date.now();
  const [pricingSettled, discoverySettled] = await Promise.allSettled([
    tools && tools.length > 0
      ? enrichWithLivePricing(plugin, tools)
      : Promise.resolve(plugin.commonFields),
    resolveDynamicFields(plugin.commonFields),
  ]);

  const pricedFields =
    pricingSettled.status === "fulfilled"
      ? pricingSettled.value
      : plugin.commonFields;

  const discoveredFields =
    discoverySettled.status === "fulfilled"
      ? discoverySettled.value
      : plugin.commonFields;

  // Merge: pricing-enriched labels + discovery-resolved options
  const dynamicFields = mergeEnrichedFields(pricedFields, discoveredFields);

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.OPTION_ELICITED,
    extras: {
      parallelFanOutMs: Date.now() - startMs,
      pricingStatus: pricingSettled.status,
      discoveryStatus: discoverySettled.status,
    },
  });

  parallelSpinner.stop("Ready");

  // Story 12.3: Inject BP-sourced hints into field prompts
  const bpHintedCommon = injectBPHints(dynamicFields, state.resourceType);
  const bpHintedAdvanced = injectBPHints(
    plugin.advancedFields,
    state.resourceType,
  );

  // Enrich with contextual metadata (cost/fit/recommended) from plugin definitions
  const enrichedCommon = enrichFieldLabels(bpHintedCommon);

  // Enrich advanced fields with contextual metadata too
  const enrichedAdvanced = enrichFieldLabels(bpHintedAdvanced);

  // Story 10.5: Apply intent-aware smart defaults — higher priority than plugin
  // initialValue, lower priority than pattern memory and user input.
  const intentOverrides = getIntentDefaults(
    state.userIntent,
    state.resourceType,
  );
  const commonFields = applyIntentOverrides(enrichedCommon, intentOverrides);
  const advancedFields = applyIntentOverrides(
    enrichedAdvanced,
    intentOverrides,
  );

  // Story 19.5: Read pattern memory for previous option defaults
  let previousOptions: Record<string, unknown> = {};
  if (state.resourcePattern) {
    try {
      const patterns = await defaultMemoryService.readPatterns();
      const match = patterns.find(
        (p) => p.pattern === state.resourcePattern!.patternId,
      );
      if (match) {
        previousOptions = match.optionsSelected;
      }
    } catch {
      // Graceful degradation — pattern memory read failure is non-blocking
    }
  }

  const resolvedCommon = resolveFieldConfigs(commonFields);
  const resolvedAdvanced = resolveFieldConfigs(advancedFields);

  // Story 19.5: Apply pattern memory defaults — higher priority than plugin defaults,
  // lower priority than org policy locks. User can still override during prompt.
  const patternHintedFields = new Set<string>();
  for (const [fieldName, resolved] of Object.entries(resolvedCommon)) {
    if (
      fieldName in previousOptions &&
      resolved.source === FieldSource.PLUGIN_DEFAULT
    ) {
      resolved.value = previousOptions[fieldName];
      patternHintedFields.add(fieldName);
    }
  }
  for (const [fieldName, resolved] of Object.entries(resolvedAdvanced)) {
    if (
      fieldName in previousOptions &&
      resolved.source === FieldSource.PLUGIN_DEFAULT
    ) {
      resolved.value = previousOptions[fieldName];
      patternHintedFields.add(fieldName);
    }
  }

  const elicitedOptions: Record<string, unknown> = {};

  // Story 10.5: Pre-inject boolean toggles from intent overrides so showIf gates
  // open for child fields (e.g., EnableLifecycle=true reveals LifecycleTransitionDays)
  for (const override of intentOverrides) {
    if (override.value === true || override.value === false) {
      elicitedOptions[override.fieldName] = override.value;
    }
  }

  // Story 19.5: Append "(from previous use)" hint to pattern-memory-defaulted fields
  const applyPatternHint = (field: ResourceField): ResourceField => {
    if (!patternHintedFields.has(field.name)) return field;
    const patternHint = "(from previous use)";
    const existingHint = field.question.hint;
    return {
      ...field,
      question: {
        ...field.question,
        hint: existingHint ? `${existingHint}\n${patternHint}` : patternHint,
      },
    };
  };

  // ── Common tier ──────────────────────────────────────────────────────────────
  for (const field of commonFields.map(applyPatternHint)) {
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
      state.userIntent,
    );
    if (answer !== undefined && answer !== "") {
      elicitedOptions[field.name] = answer;
    }
  }

  // ── Advanced tier gate ───────────────────────────────────────────────────────
  if (advancedFields.length > 0) {
    const showAdvanced = await renderAdvancedConfirm();
    if (showAdvanced) {
      for (const field of advancedFields.map(applyPatternHint)) {
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
          state.userIntent,
        );
        if (answer !== undefined && answer !== "") {
          elicitedOptions[field.name] = answer;
        }
      }
    }
  }

  // ── Post-wizard recommendations (Story 10.7) ─────────────────────────────
  const recommendations = evaluateWizardRecommendations(
    elicitedOptions,
    state.userIntent ?? "",
    state.resourceType,
  );
  displayRecommendations(recommendations);

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.OPTION_ELICITED,
    extras: {
      resourceType: state.resourceType,
      elicitedKeys: Object.keys(elicitedOptions),
      elicitedValues: Object.fromEntries(
        Object.entries(elicitedOptions).map(([k, v]) => [
          k,
          typeof v === "object" ? "[object]" : String(v),
        ]),
      ),
    },
  });

  return { elicitedOptions };
}
