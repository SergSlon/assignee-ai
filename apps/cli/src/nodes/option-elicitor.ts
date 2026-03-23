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
  startSpinner,
  stopSpinner,
} from "../utils/display.js";
import { enrichOptionLabel } from "../utils/option-enrichment.js";
import {
  fetchEc2InstancePrices,
  fetchRdsInstancePrices,
} from "../utils/pricing-lookup.js";
import { withTimeout } from "../utils/timeout.js";
import {
  discoverAmis,
  discoverSubnets,
  discoverSecurityGroups,
  discoverKeyPairs,
  discoverInstanceTypes,
  discoverRdsEngineVersions,
  discoverRdsInstanceClasses,
  type InstanceTypeCategory,
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
import {
  classifyWorkload,
  type WorkloadProfile,
} from "../utils/workload-classifier.js";
import { rankOptions } from "../utils/option-ranker.js";
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
        (f.question.type === "enum" || f.question.type === "categorySelect"),
    );
    if (field) {
      // Collect all instance type values from either flat options or category groups
      const allValues: string[] = [];
      if (
        field.question.type === "categorySelect" &&
        field.question.categories
      ) {
        for (const cat of field.question.categories) {
          for (const opt of cat.options) {
            allValues.push(opt.value);
          }
        }
      } else if (field.question.type === "enum" && field.question.options) {
        for (const opt of field.question.options) {
          allValues.push(opt.value);
        }
      }
      if (allValues.length > 0) {
        const priceMap = await fetchEc2InstancePrices(tools, allValues);
        return { fieldName: ResourceFieldName.INSTANCE_TYPE, priceMap };
      }
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

/** Injects live price labels into enum/categorySelect option fields. */
function injectPriceLabels(
  fields: ResourceField[],
  fieldName: string,
  priceMap: Record<string, string>,
): ResourceField[] {
  const enrichLabel = (opt: { value: string; label: string }) => {
    const livePrice = priceMap[opt.value];
    if (!livePrice) return opt;
    const label = opt.label.includes(" — ")
      ? `${opt.label.split(" — ")[0]} — ${livePrice}`
      : `${opt.label} — ${livePrice}`;
    return { ...opt, label };
  };

  return fields.map((field) => {
    if (field.name !== fieldName) return field;

    if (field.question.type === "categorySelect" && field.question.categories) {
      return {
        ...field,
        question: {
          ...field.question,
          categories: field.question.categories.map((cat) => ({
            ...cat,
            options: cat.options.map(enrichLabel),
          })),
        },
      };
    }

    if (field.question.type === "enum") {
      return {
        ...field,
        question: {
          ...field.question,
          options: field.question.options?.map(enrichLabel),
        },
      };
    }

    return field;
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
    if (field.question.type === "categorySelect" && field.question.categories) {
      return {
        ...field,
        question: {
          ...field.question,
          categories: field.question.categories.map((cat) => ({
            ...cat,
            options: cat.options.map((opt) => ({
              ...opt,
              label: enrichOptionLabel(opt),
            })),
          })),
        },
      };
    }
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
 * Maps a workload profile to the corresponding category key used in the
 * EC2 InstanceType categorySelect field.
 * Returns undefined for profiles that don't map to a known category (gpu-accelerated, storage-heavy, unknown).
 *
 * @see Story 21.3
 */
const PROFILE_TO_CATEGORY: Partial<Record<WorkloadProfile, string>> = {
  burstable: "burstable",
  "general-purpose": "general",
  "compute-heavy": "compute",
  "memory-intensive": "memory",
};

/** GPU note shown when gpu-accelerated profile is detected. */
const GPU_CATEGORY_NOTE =
  "GPU instances not in categories \u2014 use 'Other' for p5/g6 types";

/**
 * Applies workload-based smart filtering to categorySelect fields (e.g., EC2 InstanceType).
 *
 * - Reorders categories so the workload-matching category appears first
 * - Appends "(recommended for your workload)" hint to the matching category label
 * - Ranks options within the matching category using `rankOptions()`
 * - For gpu-accelerated profile: adds a note via the field hint
 * - For unknown/undefined profile: no changes
 *
 * Pure transformation — no I/O, no mutations to inputs.
 *
 * @see Story 21.3
 */
export function applyCategorySmartFilter(
  fields: ResourceField[],
  profile: WorkloadProfile | undefined,
): ResourceField[] {
  if (!profile || profile === "unknown") return fields;

  const targetCategory = PROFILE_TO_CATEGORY[profile];

  return fields.map((field) => {
    if (
      field.question.type !== "categorySelect" ||
      !field.question.categories
    ) {
      return field;
    }

    // GPU profile: no matching category, just add a hint
    if (profile === "gpu-accelerated" || profile === "storage-heavy") {
      const gpuHint =
        profile === "gpu-accelerated" ? GPU_CATEGORY_NOTE : undefined;
      if (!gpuHint) return field;
      const existingHint = field.question.hint;
      return {
        ...field,
        question: {
          ...field.question,
          hint: existingHint ? `${existingHint}\n${gpuHint}` : gpuHint,
        },
      };
    }

    if (!targetCategory) return field;

    // Mutable copy of categories array for reordering
    const categories = [...field.question.categories];
    const matchIdx = categories.findIndex((c) => c.key === targetCategory);
    if (matchIdx < 0) return field;

    // Rank options within the matching category
    const matchedCat = categories[matchIdx]!;
    const ranked = rankOptions(
      [...matchedCat.options] as Array<
        { value: string; label: string } & Record<string, unknown>
      >,
      profile,
      matchedCat.options.length,
    );
    const rankedOptions = [...ranked.visible, ...ranked.overflow];

    // Build the enhanced matching category with "(recommended for your workload)" label
    const enhancedCat = {
      ...matchedCat,
      label: `${matchedCat.label} (recommended for your workload)`,
      options: rankedOptions,
    };

    // Reorder: put matching category first, keep others in original order
    const reordered = [
      enhancedCat,
      ...categories.filter((_, i) => i !== matchIdx),
    ];

    return {
      ...field,
      question: {
        ...field.question,
        categories: reordered,
      },
    };
  });
}

/**
 * Applies workload-based ranking to enum fields with many options (>10).
 * Reorders options so the most relevant ones appear first.
 * Only applies when a known workload profile is detected; "unknown" skips ranking.
 *
 * @see Story 21.4
 */
export function applyOptionRanking(
  fields: ResourceField[],
  profile: WorkloadProfile,
): ResourceField[] {
  if (profile === "unknown") return fields;

  return fields.map((field) => {
    if (field.question.type !== "enum" || !field.question.options) return field;
    if (field.question.options.length <= 10) return field;

    const ranked = rankOptions(
      [...field.question.options] as Array<
        { value: string; label: string } & Record<string, unknown>
      >,
      profile,
      field.question.options.length,
    );

    // If ranking was not applied (e.g. unknown profile fallback), keep original order
    if (!ranked.filtered) return field;

    return {
      ...field,
      question: {
        ...field.question,
        options: [...ranked.visible, ...ranked.overflow],
      },
    };
  });
}

/** Maps fetcher identifiers to discovery functions. */
const fetcherMap: Record<
  string,
  (
    context?: Record<string, unknown>,
  ) => Promise<Array<{ value: string; label: string }>>
> = {
  "discover-amis": discoverAmis,
  "discover-subnets": discoverSubnets,
  "discover-security-groups": discoverSecurityGroups,
  "discover-key-pairs": discoverKeyPairs,
  "discover-rds-engine-versions": discoverRdsEngineVersions,
  "discover-rds-instance-classes": discoverRdsInstanceClasses,
};

/** Human-readable spinner messages per fetcher ID. */
const fetcherSpinnerMessages: Record<string, string> = {
  "discover-amis": "Discovering available AMIs...",
  "discover-subnets": "Discovering available subnets...",
  "discover-security-groups": "Discovering security groups...",
  "discover-key-pairs": "Discovering key pairs...",
  "discover-rds-engine-versions":
    "Fetching available database engine versions from AWS...",
  "discover-rds-instance-classes":
    "Fetching available database instance classes from AWS...",
};

/**
 * Returns a spinner message appropriate for the set of fetcher IDs that will run.
 * Single fetcher -> resource-specific message; multiple -> generic message.
 * Returns null if no dynamic fields need fetching.
 */
function getDiscoverySpinnerMessage(fields: ResourceField[]): string | null {
  const fetcherIds = new Set(
    fields
      .filter((f) => f.question.fetcher && fetcherMap[f.question.fetcher])
      .map((f) => f.question.fetcher!),
  );
  if (fetcherIds.size === 0) return null;
  if (fetcherIds.size === 1) {
    const id = [...fetcherIds][0]!;
    return (
      fetcherSpinnerMessages[id] ?? "Discovering available options from AWS..."
    );
  }
  return "Discovering available options from AWS...";
}

/**
 * Resolves dynamic fields by fetching live options from AWS.
 * Fields with a `fetcher` identifier get their options populated at runtime.
 * If a fetch returns empty results, the field reverts to string type for manual entry.
 * Spinner-free — callers are responsible for spinner lifecycle.
 * @see Story 7.11
 */
/** Unique key for a field in fetchResults — disambiguates fields sharing the same name (e.g., EngineVersion per engine). */
function fieldFetchKey(field: ResourceField): string {
  if (field.question.showIf) {
    return `${field.name}::${field.question.showIf.field}=${String(field.question.showIf.value)}`;
  }
  return field.name;
}

async function resolveDynamicFields(
  fields: ResourceField[],
  context?: Record<string, unknown>,
): Promise<ResourceField[]> {
  const dynamicFields = fields.filter((f) => f.question.fetcher);
  if (dynamicFields.length === 0) return fields;

  const fetchResults = new Map<
    string,
    Array<{ value: string; label: string }>
  >();
  const warnedKeys = new Set<string>();
  await Promise.all(
    dynamicFields.map(async (field) => {
      const fetch = fetcherMap[field.question.fetcher!];
      if (!fetch) return;
      const key = fieldFetchKey(field);
      try {
        // Build per-field context: merge global context with showIf condition data
        // so fetchers like discover-rds-engine-versions know which engine to query.
        const fieldContext = field.question.showIf
          ? {
              ...context,
              [field.question.showIf.field]: field.question.showIf.value,
            }
          : context;
        const options = await fetch(fieldContext);
        fetchResults.set(key, options);
      } catch {
        clack.log.warn(
          `Could not discover ${field.question.label ?? field.name} from your account. Enter manually.`,
        );
        warnedKeys.add(key);
        fetchResults.set(key, []);
      }
    }),
  );

  return fields.map((field) => {
    if (!field.question.fetcher) return field;
    const key = fieldFetchKey(field);
    const options = fetchResults.get(key) ?? [];

    if (options.length === 0) {
      // Check if the field has static fallback options defined in the plugin
      const staticOptions = field.question.options;
      const hasStaticFallback =
        Array.isArray(staticOptions) && staticOptions.length > 0;

      if (hasStaticFallback) {
        // Static defaults exist — show them with an outdated-data warning
        if (!warnedKeys.has(key)) {
          clack.log.warn(
            "Could not reach AWS. Showing default options \u2014 versions may be outdated.",
          );
        }
        return {
          ...field,
          question: {
            ...field.question,
            // Keep the existing static options; clear fetcher so we don't retry
            fetcher: undefined,
          },
        };
      }

      // No static fallback — revert to manual string entry.
      // Only warn if the catch block didn't already warn for this field.
      if (!warnedKeys.has(key)) {
        clack.log.warn(
          `Could not discover ${field.question.label ?? field.name} from your account. Enter manually.`,
        );
      }
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
  // Index by composite key (name + showIf) so fields sharing a name but
  // distinguished by showIf conditions (e.g., EngineVersion per engine)
  // are each preserved during the merge.
  const discoveryMap = new Map(
    discoveryFields.map((f) => [fieldFetchKey(f), f]),
  );

  return pricedFields.map((field) => {
    // For fields with a fetcher, ALWAYS use the discovery version —
    // it either has resolved options or fell back to string type.
    // For non-fetcher fields (e.g., InstanceType), use the priced version
    // which has live pricing labels enriched.
    if (field.question.fetcher) {
      return discoveryMap.get(fieldFetchKey(field)) ?? field;
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

/**
 * Fetches a price hint for an LLM-suggested value, if the field is a known
 * priced resource type (EC2 InstanceType, RDS DBInstanceClass).
 * Returns a formatted price string (e.g. "$0.0416/hr") or null.
 * Never throws — returns null on any failure or timeout.
 */
async function fetchSuggestionPrice(
  suggested: string,
  fieldName: string,
  resourceType: string,
  tools: StructuredTool[],
): Promise<string | null> {
  try {
    let priceMap: Record<string, string> | null = null;

    if (resourceType === "AWS::EC2::Instance" && fieldName === "InstanceType") {
      priceMap = await withTimeout(
        fetchEc2InstancePrices(tools, [suggested]),
        3000,
      );
    } else if (
      resourceType === "AWS::RDS::DBInstance" &&
      fieldName === "DBInstanceClass"
    ) {
      // Default to postgres since we may not know the selected engine here
      priceMap = await withTimeout(
        fetchRdsInstancePrices(tools, [suggested], "postgres"),
        3000,
      );
    } else {
      return null;
    }

    if (!priceMap) return null;
    return priceMap[suggested] ?? null;
  } catch {
    return null;
  }
}

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
      answer === "?" || (Array.isArray(answer) && answer.includes("?"));

    if (isHelpRequest) {
      const isEnumOrMulti =
        field.question.type === "enum" || field.question.type === "multi";
      const isCategorySelect = field.question.type === "categorySelect";

      if (isEnumOrMulti && field.question.options && llmClient) {
        cachedHint = await renderTradeoffHelp(
          field.name,
          resourceType,
          [...field.question.options],
          userIntent ?? "",
          tools,
          llmClient,
        );
      } else if (isCategorySelect && field.question.categories && llmClient) {
        // Collect all options from all categories for the trade-off analysis
        const allOpts = field.question.categories.flatMap((c) =>
          c.options.map((o) => ({ value: o.value, label: o.label })),
        );
        cachedHint = await renderTradeoffHelp(
          field.name,
          resourceType,
          allOpts,
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

    // "Other" — LLM-assisted value input for any enum/categorySelect field
    if (answer === "__other__") {
      const description = await clack.text({
        message: `${field.question.label} — Describe what you need`,
        placeholder: "e.g., 'GPU for ML training' or enter exact value",
      });
      if (clack.isCancel(description)) {
        clack.cancel("Wizard cancelled.");
        process.exit(130);
      }
      const userDesc =
        typeof description === "string" ? description.trim() : "";
      if (!userDesc) continue; // re-prompt

      // If it looks like an exact value (e.g., "p3.2xlarge"), return it directly
      if (/^[a-z0-9][a-z0-9.-]*$/i.test(userDesc) && !userDesc.includes(" ")) {
        return userDesc;
      }

      // Use LLM to suggest the right value
      if (llmClient) {
        const s = clack.spinner();
        s.start("Finding the best option for you...");
        try {
          const prompt = [
            `The user is configuring a ${resourceType} resource.`,
            `They need to set the "${field.name}" field.`,
            `They described what they need as: "${userDesc}"`,
            userIntent ? `Their overall intent: "${userIntent}"` : "",
            "",
            "Respond with ONLY the exact valid AWS value (nothing else).",
            "For example, if they want a GPU instance for ML, respond: p3.2xlarge",
            "If they want a PostgreSQL version, respond: 16",
          ].join("\n");

          const [err, text] = await llmClient.generateText(prompt);
          s.stop();

          if (!err && text) {
            const suggested = text.trim().split("\n")[0]?.trim();
            if (!suggested) {
              clack.log.warn("Could not determine a suggestion");
              continue; // re-prompt
            }

            // Fetch price for suggested value (non-blocking)
            let priceHint = "";
            if (suggested) {
              const ps = clack.spinner();
              ps.start("Checking price...");
              const price = await fetchSuggestionPrice(
                suggested,
                field.name,
                resourceType,
                tools,
              );
              ps.stop();
              if (price) priceHint = ` (~${price})`;
            }

            const confirm = await clack.confirm({
              message: `Suggested: ${suggested}${priceHint} — use this?`,
              initialValue: true,
            });
            if (clack.isCancel(confirm)) {
              clack.cancel("Wizard cancelled.");
              process.exit(130);
            }
            if (confirm) return suggested;
            // User rejected suggestion — re-prompt the field
            continue;
          }
        } catch {
          s.stop("Could not get suggestion");
        }
      }

      // Fallback: let user type an exact value
      const manualValue = await clack.text({
        message: `${field.question.label} — Enter the exact value`,
        placeholder: "e.g., t3.medium, p3.2xlarge",
      });
      if (clack.isCancel(manualValue)) {
        clack.cancel("Wizard cancelled.");
        process.exit(130);
      }
      const val = typeof manualValue === "string" ? manualValue.trim() : "";
      if (val) return val;
      continue; // re-prompt if empty
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
  // Story 20.6: Use resource-specific spinner message when fetching dynamic options
  const discoveryMessage = getDiscoverySpinnerMessage(plugin.commonFields);
  const spinnerMessage = discoveryMessage ?? "Preparing your wizard\u2026";
  parallelSpinner.start(spinnerMessage);

  // Story 21.1: Classify workload profile in parallel with pricing/discovery.
  // Result stored for Story 21.2 (smart option filtering).
  let workloadProfile: WorkloadProfile = "unknown";

  const startMs = Date.now();
  const [
    pricingSettled,
    discoverySettled,
    instanceTypesSettled,
    classificationSettled,
  ] = await Promise.allSettled([
    tools && tools.length > 0
      ? enrichWithLivePricing(plugin, tools)
      : Promise.resolve(plugin.commonFields),
    resolveDynamicFields(plugin.commonFields, {}),
    // Fetch real instance types from AWS for EC2 categorySelect
    state.resourceType === RESOURCE_TYPES.EC2_INSTANCE
      ? discoverInstanceTypes()
      : Promise.resolve(null),
    // Story 21.1: LLM-based workload classification
    llmClient && state.userIntent
      ? classifyWorkload(state.userIntent, llmClient)
      : Promise.resolve("unknown" as WorkloadProfile),
  ]);

  // Story 21.1: Extract classification result
  if (classificationSettled.status === "fulfilled") {
    workloadProfile = classificationSettled.value;
  }

  const pricedFields =
    pricingSettled.status === "fulfilled"
      ? pricingSettled.value
      : plugin.commonFields;

  const discoveredFields =
    discoverySettled.status === "fulfilled"
      ? discoverySettled.value
      : plugin.commonFields;

  // If real instance types were fetched, replace hardcoded categories on the InstanceType field
  const liveCategories: InstanceTypeCategory[] | null =
    instanceTypesSettled.status === "fulfilled"
      ? (instanceTypesSettled.value as InstanceTypeCategory[] | null)
      : null;

  // Merge: pricing-enriched labels + discovery-resolved options
  let dynamicFields = mergeEnrichedFields(pricedFields, discoveredFields);

  // Replace hardcoded categorySelect categories with live data if available
  if (liveCategories && liveCategories.length > 0) {
    dynamicFields = dynamicFields.map((field) => {
      if (
        field.name !== "InstanceType" ||
        field.question.type !== "categorySelect"
      )
        return field;
      return {
        ...field,
        question: {
          ...field.question,
          categories: liveCategories,
        },
      };
    });
  }

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.OPTION_ELICITED,
    extras: {
      parallelFanOutMs: Date.now() - startMs,
      pricingStatus: pricingSettled.status,
      discoveryStatus: discoverySettled.status,
      workloadProfile,
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

  // Story 21.3: Smart-filter categorySelect fields (EC2 InstanceType) by workload profile.
  // Reorders categories so the matching one appears first, ranks within-category options.
  const categoryFilteredCommon = applyCategorySmartFilter(
    enrichedCommon,
    workloadProfile,
  );

  // Story 21.4: Rank enum fields with many options (>10) by workload relevance.
  // Applied after enrichment so labels are already finalized.
  const rankedCommon = applyOptionRanking(
    categoryFilteredCommon,
    workloadProfile,
  );

  // Story 10.5: Apply intent-aware smart defaults — higher priority than plugin
  // initialValue, lower priority than pattern memory and user input.
  const intentOverrides = getIntentDefaults(
    state.userIntent,
    state.resourceType,
  );
  const commonFields = applyIntentOverrides(rankedCommon, intentOverrides);
  const advancedFields = applyIntentOverrides(
    enrichedAdvanced,
    intentOverrides,
  );

  // Story 19.5: Pattern memory block removed — compound intents (resourcePattern set)
  // return early at line 543, so this code was unreachable dead code.
  const previousOptions: Record<string, unknown> = {};

  const resolvedCommon = resolveFieldConfigs(commonFields);
  const resolvedAdvanced = resolveFieldConfigs(advancedFields);

  // Story 18.12: Propagate categoryHint from intent overrides into resolved configs
  for (const override of intentOverrides) {
    if (override.categoryHint) {
      const resolved = resolvedCommon[override.fieldName];
      if (resolved) {
        resolved.categoryHint = override.categoryHint;
      }
    }
  }

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
  // open for child fields (e.g., EnableLifecycle=true reveals LifecycleTransitionDays).
  // Only pre-inject for commonFields — advanced field toggles require user confirmation.
  const commonFieldNames = new Set(commonFields.map((f) => f.name));
  for (const override of intentOverrides) {
    if (
      (override.value === true || override.value === false) &&
      commonFieldNames.has(override.fieldName)
    ) {
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

  startSpinner("Generating your plan...");

  return { elicitedOptions };
}
