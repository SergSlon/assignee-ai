/**
 * Wizard helper functions extracted from option-elicitor.ts.
 * Contains field evaluation, dynamic field resolution, label enrichment,
 * smart filtering/ranking, BP hint injection, and prompt-with-help logic.
 *
 * @see option-elicitor.ts for the main wizard loop that consumes these helpers.
 */

import * as clack from "@clack/prompts";
import {
  RESOURCE_TYPES,
  MissingRequiredFieldsError,
  UserCancelledError,
  CfnKey,
  ResourceDefault,
} from "@assignee/core";
import { PRICING_LOOKUP_TIMEOUT_MS } from "../config/constants.js";
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
  renderDocHelp,
  renderTradeoffHelp,
  BACK_SENTINEL,
  HELP_SENTINEL,
  OTHER_SENTINEL,
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
  discoverRdsEngineVersions,
  discoverRdsInstanceClasses,
  searchAmis,
} from "../utils/aws-resource-discovery.js";
import { FieldPolicy, FieldSource } from "../constants/field-policy.js";
import { ResourceFieldName } from "../constants/resource-fields.js";
import { rankOptions } from "../utils/option-ranker.js";
import type { WorkloadProfile } from "../utils/workload-classifier.js";

// ── Field key helpers ─────────────────────────────────────────────────────────

/** Unique key for a field in fetchResults — disambiguates fields sharing the same name (e.g., EngineVersion per engine). */
export function fieldFetchKey(field: ResourceField): string {
  if (field.question.showIf) {
    const cond = field.question.showIf;
    const suffix = cond.pattern ?? String(cond.value);
    return `${field.name}::${cond.field}=${suffix}`;
  }
  return field.name;
}

// ── ShowIf evaluation ─────────────────────────────────────────────────────────

/**
 * Evaluates a showIf condition against the current field answers.
 * Supports exact `value` match and regex `pattern` match.
 */
export function evaluateShowIf(
  condition: { field: string; value?: unknown; pattern?: string },
  answers: Record<string, unknown>,
): boolean {
  const depValue = answers[condition.field];
  if (condition.pattern) {
    return new RegExp(condition.pattern).test(String(depValue ?? ""));
  }
  // When value is boolean true, treat as a truthy check (supports arrays, strings, etc.)
  if (condition.value === true) {
    if (Array.isArray(depValue)) return depValue.length > 0;
    return !!depValue;
  }
  if (condition.value === false) {
    if (Array.isArray(depValue)) return depValue.length === 0;
    return !depValue;
  }
  return depValue === condition.value;
}

// ── Populate default options (no-wizard mode) ─────────────────────────────────

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

// ── Label enrichment ──────────────────────────────────────────────────────────

/**
 * Enriches enum option labels with contextual metadata (cost/fit/recommended).
 * Pure in-memory transformation — no I/O, no mutations.
 * Only enriches in TTY mode (display-only).
 */
export function enrichFieldLabels(fields: ResourceField[]): ResourceField[] {
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

// ── Category smart filter ─────────────────────────────────────────────────────

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

// ── Option ranking ────────────────────────────────────────────────────────────

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

// ── Fetcher map & dynamic field resolution ────────────────────────────────────

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
export function getDiscoverySpinnerMessage(
  fields: ResourceField[],
): string | null {
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
export async function resolveDynamicFields(
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

// ── Pricing helpers ───────────────────────────────────────────────────────────

/**
 * Fetches live prices for a specific resource type and returns the field name + price map.
 * Spinner-free — callers are responsible for spinner lifecycle.
 */
export async function fetchPricesForResource(
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
          ResourceDefault.RDS_ENGINE_POSTGRES)
        : ResourceDefault.RDS_ENGINE_POSTGRES;
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
export function injectPriceLabels(
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
export async function enrichWithLivePricing(
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

// ── Merge enriched fields ─────────────────────────────────────────────────────

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
export function mergeEnrichedFields(
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

// ── BP hint injection ─────────────────────────────────────────────────────────

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

// ── Suggestion price lookup ───────────────────────────────────────────────────

/**
 * Fetches a price hint for an LLM-suggested value, if the field is a known
 * priced resource type (EC2 InstanceType, RDS DBInstanceClass).
 * Returns a formatted price string (e.g. "$0.0416/hr") or null.
 * Never throws — returns null on any failure or timeout.
 */
export async function fetchSuggestionPrice(
  suggested: string,
  fieldName: string,
  resourceType: string,
  tools: StructuredTool[],
): Promise<string | null> {
  try {
    let priceMap: Record<string, string> | null = null;

    if (
      resourceType === RESOURCE_TYPES.EC2_INSTANCE &&
      fieldName === CfnKey.INSTANCE_TYPE
    ) {
      priceMap = await withTimeout(
        fetchEc2InstancePrices(tools, [suggested]),
        PRICING_LOOKUP_TIMEOUT_MS,
      );
    } else if (
      resourceType === RESOURCE_TYPES.RDS_DB_INSTANCE &&
      fieldName === CfnKey.DB_INSTANCE_CLASS
    ) {
      // Default to postgres since we may not know the selected engine here
      priceMap = await withTimeout(
        fetchRdsInstancePrices(
          tools,
          [suggested],
          ResourceDefault.RDS_ENGINE_POSTGRES,
        ),
        PRICING_LOOKUP_TIMEOUT_MS,
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

// ── Prompt with help loop ─────────────────────────────────────────────────────

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
 * @param resourceType - The AWS resource type (e.g. RESOURCE_TYPES.S3_BUCKET)
 * @param tools        - LangChain tools array (passed through from node)
 * @param llmClient    - Optional LLM client forwarded to renderDocHelp/renderTradeoffHelp
 * @param userIntent   - Optional user intent string for context-aware trade-off analysis
 */
export async function promptWithHelp(
  field: ResourceField,
  resolved: ResolvedFieldConfig,
  resourceType: string,
  tools: StructuredTool[],
  llmClient?: LlmPort,
  userIntent?: string,
  showBack = false,
  answers?: Record<string, unknown>,
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

    const answer = await renderOptionPrompt(
      promptField,
      resolved,
      showBack,
      answers,
    );

    // Back navigation — return sentinel to caller (handle both scalar and array from multi-select)
    if (
      answer === BACK_SENTINEL ||
      (Array.isArray(answer) && answer.includes(BACK_SENTINEL))
    ) {
      return BACK_SENTINEL;
    }

    // Multi fields: when user selects only '?', trigger help
    const isHelpRequest =
      answer === HELP_SENTINEL ||
      (Array.isArray(answer) && answer.includes(HELP_SENTINEL));

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
    if (answer === OTHER_SENTINEL) {
      const description = await clack.text({
        message: `${field.question.label} — Describe what you need`,
        placeholder: "e.g., 'GPU for ML training' or enter exact value",
      });
      if (clack.isCancel(description)) {
        clack.cancel("Wizard cancelled.");
        throw new UserCancelledError();
      }
      const userDesc =
        typeof description === "string" ? description.trim() : "";
      if (!userDesc) continue; // re-prompt

      // If it looks like an exact AWS value (e.g., "p3.2xlarge", "ami-0c55b", "db.t3.micro"),
      // return it directly. Must contain a dot, dash-with-digits, or AWS prefix to qualify.
      // Plain words like "linux" or "gpu" are descriptions, not exact values.
      const looksLikeAwsValue =
        !userDesc.includes(" ") &&
        /^[a-z0-9][a-z0-9._-]*$/i.test(userDesc) &&
        (/\./.test(userDesc) || // has dot: t3.small, db.t3.micro
          /^ami-/.test(userDesc) || // AMI ID
          /^subnet-/.test(userDesc) || // subnet ID
          /^sg-/.test(userDesc) || // security group ID
          /^i-/.test(userDesc) || // instance ID
          /^arn:/.test(userDesc) || // ARN
          /^db\./.test(userDesc) || // RDS class
          /\d+\.\d+/.test(userDesc)); // version: 16.4, 8.0
      if (looksLikeAwsValue) {
        return userDesc;
      }

      // Story 20.9: AMI search by description via ec2:DescribeImages
      if (field.name === CfnKey.IMAGE_ID) {
        const amiSpinner = clack.spinner();
        amiSpinner.start("Searching for matching AMIs...");
        const amiResults = await searchAmis(userDesc);
        amiSpinner.stop();

        if (amiResults.length > 0) {
          const amiChoice = await clack.select({
            message: `Found ${amiResults.length} matching AMI${amiResults.length === 1 ? "" : "s"}:`,
            options: [
              ...amiResults.map((ami) => ({
                value: ami.value,
                label: ami.label,
              })),
              { value: "__none__", label: "None of these — let me try again" },
            ],
          });
          if (clack.isCancel(amiChoice)) {
            clack.cancel("Wizard cancelled.");
            throw new UserCancelledError();
          }
          if (amiChoice !== "__none__") {
            return amiChoice as string;
          }
          // User rejected all results — fall through to LLM suggestion
        }
      }

      // Use LLM to suggest the right value
      if (llmClient) {
        const s = clack.spinner();
        s.start("Finding the best option for you...");
        try {
          // Build field-aware prompt with available options context
          const staticOptions = field.question.options ?? [];
          const optionsContext =
            staticOptions.length > 0
              ? `\nAvailable options: ${staticOptions.map((o) => `${o.value} (${o.label})`).join(", ")}\nPick the best matching option value from the list above.`
              : "";
          const prompt = [
            `The user is configuring a ${resourceType} resource.`,
            `They need to set the "${field.name}" field.`,
            `They described what they need as: "${userDesc}"`,
            userIntent ? `Their overall intent: "${userIntent}"` : "",
            optionsContext,
            "",
            "Respond with ONLY the exact value (a single short string, nothing else — no explanation, no sentences).",
            "Examples: p3.2xlarge, amazon-linux-2023, postgres, 16, db.r6g.large",
          ].join("\n");

          const [err, text] = await llmClient.generateText(prompt);
          s.stop();

          if (!err && text) {
            const suggested = text.trim().split("\n")[0]?.trim();
            if (!suggested || suggested.length > 100) {
              // LLM returned empty or a paragraph instead of a short value
              clack.log.warn(
                "Could not determine a suggestion. Please enter an exact value.",
              );
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
              throw new UserCancelledError();
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
        throw new UserCancelledError();
      }
      const val = typeof manualValue === "string" ? manualValue.trim() : "";
      if (val) return val;
      continue; // re-prompt if empty
    }

    return answer;
  }
}
