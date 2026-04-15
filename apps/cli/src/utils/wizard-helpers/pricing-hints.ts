/**
 * Pricing-hint injection — calls Pricing-MCP to enrich enum/categorySelect
 * labels with live $/hr information and merges discovery + pricing.
 *
 * Lazy: skipped entirely when no pricing-sensitive field exists for the
 * resource (fetchPricesForResource returns null).
 */

import {
  RESOURCE_TYPES,
  CfnKey,
  ResourceDefault,
  QuestionTypeName,
} from "@assignee/core";
import type { ResourceField, ResourcePlugin } from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import { PRICING_LOOKUP_TIMEOUT_MS } from "../../config/constants.js";
import {
  fetchEc2InstancePrices,
  fetchRdsInstancePrices,
} from "../pricing-lookup.js";
import { withTimeout } from "../timeout.js";
import { ResourceFieldName } from "../../constants/resource-fields.js";
import { fieldFetchKey } from "./show-if.js";

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
        (f.question.type === "enum" ||
          f.question.type === QuestionTypeName.CATEGORY_SELECT),
    );
    if (field) {
      // Collect all instance type values from either flat options or category groups
      const allValues: string[] = [];
      if (
        field.question.type === QuestionTypeName.CATEGORY_SELECT &&
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
    // Story 44.2: append (live) so users can distinguish MCP prices from fallbacks
    const label = opt.label.includes(" — ")
      ? `${opt.label.split(" — ")[0]} — ${livePrice} (live)`
      : `${opt.label} — ${livePrice} (live)`;
    return { ...opt, label };
  };

  /** Recompute category header with live price range when options have live prices. */
  const enrichCategoryLabel = (
    catLabel: string,
    options: ReadonlyArray<{ value: string }>,
  ): string => {
    const livePrices = options
      .map((o) => priceMap[o.value])
      .filter((p): p is string => !!p)
      .map((p) => parseFloat(p.replace("$", "").replace("/hr", "")))
      .filter((n) => !isNaN(n));
    if (livePrices.length === 0) return catLabel;
    const min = Math.min(...livePrices);
    const max = Math.max(...livePrices);
    const base = catLabel.includes(" — ") ? catLabel.split(" — ")[0] : catLabel;
    return min === max
      ? `${base} — $${min}/hr (live)`
      : `${base} — $${min}-${max}/hr (live)`;
  };

  return fields.map((field) => {
    if (field.name !== fieldName) return field;

    if (
      field.question.type === QuestionTypeName.CATEGORY_SELECT &&
      field.question.categories
    ) {
      return {
        ...field,
        question: {
          ...field.question,
          categories: field.question.categories.map((cat) => ({
            ...cat,
            label: enrichCategoryLabel(cat.label, cat.options),
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
